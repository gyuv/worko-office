import { createWorkoClient, type TokenPair, type WorkoClient } from '@worko/api-client';
import { isPortalUrl, portalForUrl, type Portal } from '@worko/domain';
import { NEVER_AUTOFILL } from './manifest.js';
import type { FillMessage, PopupRequest, PopupResponse, SecretItem } from './messages.js';

import { DEFAULT_API_BASE } from './bg-constants.js';
export { DEFAULT_API_BASE };
const TOKENS_KEY = 'tokens';

/**
 * Token store backed by chrome.storage.session (memory only, cleared when the browser closes).
 * The client's store interface is synchronous, so we keep a cache that is hydrated on every request
 * (the service worker may have been restarted) and write-through on change.
 */
let cache: TokenPair | null = null;
let pendingWrite: Promise<void> = Promise.resolve();

async function loadTokens(): Promise<void> {
  await pendingWrite;
  const r = await chrome.storage.session.get(TOKENS_KEY);
  cache = (r[TOKENS_KEY] as TokenPair | undefined) ?? null;
}

const tokenStore = {
  get: () => cache,
  set(t: TokenPair | null) {
    cache = t;
    pendingWrite = t ? chrome.storage.session.set({ [TOKENS_KEY]: t }) : chrome.storage.session.clear();
  },
};

async function clearSession(): Promise<void> {
  cache = null;
  await chrome.storage.session.clear();
}

async function settings(): Promise<{ apiBase: string; firm: string }> {
  const r = await chrome.storage.local.get(['apiBase', 'firm']);
  return { apiBase: (r.apiBase as string | undefined) ?? DEFAULT_API_BASE, firm: (r.firm as string | undefined) ?? '' };
}

let signedOutFlag = false;
async function client(): Promise<WorkoClient> {
  const { apiBase } = await settings();
  signedOutFlag = false;
  return createWorkoClient({
    baseUrl: apiBase,
    tokens: tokenStore,
    fetch: (i, init) => globalThis.fetch(i, init),
    onWipe: () => { signedOutFlag = true; void clearSession(); },
    onSignedOut: () => { signedOutFlag = true; void clearSession(); },
  });
}

/** The active tab, and its portal if (and only if) its URL is an allow-listed https portal host. */
async function activeTab(): Promise<{ id: number; url: string; portal: Portal | null } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return null;
  const url = tab.url ?? '';
  const portal = portalForUrl(url);
  return { id: tab.id, url, portal: portal && !NEVER_AUTOFILL.includes(portal) ? portal : null };
}

function errCode(e: unknown): string | undefined {
  return (e as { code?: string } | undefined)?.code;
}

function fail(error: string, extra: Partial<{ needsStepUp: boolean; signedOut: boolean }> = {}): PopupResponse {
  return { ok: false, error, ...extra };
}

export function isApiBase(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch { return false; }
}

export async function handle(req: PopupRequest): Promise<PopupResponse> {
  await loadTokens();
  switch (req.type) {
    case 'status': {
      const s = await settings();
      const tab = await activeTab();
      return { ok: true, paired: !!cache, apiBase: s.apiBase, firm: s.firm, portal: tab?.portal ?? null };
    }
    case 'pair': {
      if (!isApiBase(req.apiBase) || !req.firm.trim() || !req.code.trim()) return fail('INVALID_INPUT');
      const apiBase = req.apiBase.replace(/\/+$/, '');
      await chrome.storage.local.set({ apiBase, firm: req.firm.trim() });
      await clearSession();
      const api = await client();
      const r = await api.POST('/auth/extension/pair', { body: { firm: req.firm.trim(), code: req.code.trim() } });
      if (!r.data) return fail(errCode(r.error) ?? 'PAIR_FAILED');
      tokenStore.set(r.data);
      await pendingWrite;
      return { ok: true };
    }
    case 'list': {
      if (!cache) return fail('NOT_PAIRED', { signedOut: true });
      const tab = await activeTab();
      if (!tab?.portal) return { ok: true, secrets: [] };
      const api = await client();
      const r = await api.GET('/vault/secrets', { params: { query: { portal: tab.portal, ...(req.q ? { q: req.q } : {}) } } });
      if (!r.data) return fail(errCode(r.error) ?? 'LIST_FAILED', { signedOut: signedOutFlag });
      const secrets: SecretItem[] = r.data
        .filter((s) => s.portal === tab.portal)
        .map((s) => ({ id: s.id, clientName: s.clientName, label: s.label, usernameHint: s.usernameHint, portal: s.portal }));
      return { ok: true, secrets };
    }
    case 'stepUp': {
      if (!cache) return fail('NOT_PAIRED', { signedOut: true });
      const body = req.totp ? { totp: req.totp } : req.password ? { password: req.password } : null;
      if (!body) return fail('INVALID_INPUT');
      const api = await client();
      const r = await api.POST('/auth/step-up', { body });
      return r.data ? { ok: true } : fail(errCode(r.error) ?? 'STEP_UP_FAILED', { signedOut: signedOutFlag });
    }
    case 'fill':
      return fill(req.secretId);
    case 'signOut': {
      if (cache) {
        const api = await client();
        await api.POST('/auth/logout', {}).catch(() => undefined);
      }
      await clearSession();
      return { ok: true };
    }
  }
}

async function fill(secretId: string): Promise<PopupResponse> {
  if (!cache) return fail('NOT_PAIRED', { signedOut: true });
  const tab = await activeTab();
  if (!tab?.portal) return fail('NOT_PORTAL');
  const api = await client();

  // Confirm the secret belongs to this tab's portal (metadata only).
  const list = await api.GET('/vault/secrets', { params: { query: { portal: tab.portal } } });
  const secret = list.data?.find((s) => s.id === secretId);
  if (!secret || secret.portal !== tab.portal || !isPortalUrl(secret.portal, tab.url)) return fail('NOT_PORTAL');

  const r = await api.POST('/vault/secrets/{id}/reveal', {
    params: { path: { id: secret.id } },
    body: { purpose: 'autofill', pageUrl: tab.url },
  });
  if (!r.data) {
    const code = errCode(r.error);
    if (code === 'STEP_UP_REQUIRED') return fail(code, { needsStepUp: true });
    return fail(code ?? 'REVEAL_FAILED', { signedOut: signedOutFlag });
  }

  let msg: FillMessage | null = { type: 'worko:fill', portal: secret.portal, username: r.data.username, password: r.data.password };
  r.data.username = ''; r.data.password = '';
  try {
    // Re-read the tab: it may have navigated while we were talking to the server.
    const now = await chrome.tabs.get(tab.id);
    if (!now.url || !isPortalUrl(secret.portal, now.url)) return fail('NOT_PORTAL');
    const res = (await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 })) as { ok: boolean; filled?: number; reason?: string } | undefined;
    if (!res?.ok) return fail(res?.reason ?? 'FILL_FAILED');
    return { ok: true, filled: res.filled ?? 0 };
  } catch {
    return fail('FILL_FAILED');
  } finally {
    if (msg) { msg.username = ''; msg.password = ''; }
    msg = null;
  }
}

/** Accept requests only from this extension's own pages (the popup) — never from content scripts or other extensions. */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab;
}
