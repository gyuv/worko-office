import { PORTAL_LABELS } from './portal-labels.js';
import { DEFAULT_API_BASE } from './bg-constants.js';
import type { PopupRequest, PopupResponse, SecretItem } from './messages.js';
import { S } from './strings.js';

const app = document.getElementById('app')!;
const DEFAULT_ORIGINS = ['http://localhost:3000', 'https://worko.in'];

function send(req: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(req) as Promise<PopupResponse>;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

function field(label: string, input: HTMLInputElement): HTMLLabelElement {
  return h('label', {}, label, input);
}

function msg(text: string, cls: 'err' | 'ok' | '' = ''): HTMLParagraphElement {
  return h('p', { className: cls, role: cls === 'err' ? 'alert' : 'status' }, text);
}

function isDefaultOrigin(origin: string): boolean {
  return DEFAULT_ORIGINS.includes(origin) || origin.endsWith('.worko.in') && origin.startsWith('https://');
}

async function render(): Promise<void> {
  app.replaceChildren(msg(S.loading));
  const st = await send({ type: 'status' });
  if (!st.ok || !('paired' in st)) { app.replaceChildren(msg(S.fillFailed, 'err')); return; }
  if (!st.paired) renderPair(st.apiBase, st.firm); else renderPaired(st.portal);
}

function renderPair(apiBase: string, firm: string): void {
  const firmIn = h('input', { name: 'firm', value: firm, required: true, autocomplete: 'organization' });
  const codeIn = h('input', { name: 'code', required: true, autocomplete: 'one-time-code' });
  const apiIn = h('input', { name: 'apiBase', type: 'url', value: apiBase || DEFAULT_API_BASE, required: true });
  const status = msg('');
  const form = h('form', {}, field(S.firm, firmIn), field(S.code, codeIn), field(S.apiBase, apiIn), h('button', { type: 'submit' }, S.pair), status);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      let origin: string;
      try { origin = new URL(apiIn.value).origin; } catch { status.replaceWith(msg(S.pairFailed, 'err')); return; }
      if (!isDefaultOrigin(origin)) {
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) { form.replaceChild(msg(S.permissionDenied, 'err'), form.lastChild!); return; }
      }
      form.replaceChild(msg(S.pairing), form.lastChild!);
      const r = await send({ type: 'pair', apiBase: apiIn.value, firm: firmIn.value, code: codeIn.value });
      codeIn.value = '';
      if (r.ok) await render(); else form.replaceChild(msg(S.pairFailed, 'err'), form.lastChild!);
    })();
  });
  app.replaceChildren(h('h1', {}, S.pairHeading), msg(S.pairHelp), form);
}

function renderPaired(portal: string | null): void {
  const signOut = h('button', { type: 'button', className: 'secondary' }, S.signOut);
  signOut.addEventListener('click', () => { void send({ type: 'signOut' }).then(render); });
  const header = h('div', { className: 'row' }, h('h1', {}, S.title), signOut);
  if (!portal) { app.replaceChildren(header, msg(S.notPortal)); return; }

  const search = h('input', { type: 'search', name: 'q' });
  const list = h('ul', { ariaLabel: S.search });
  const status = h('div');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = async () => {
    const r = await send({ type: 'list', q: search.value.trim() || undefined });
    if (!r.ok) { if (r.signedOut) return render(); status.replaceChildren(msg(r.error, 'err')); return; }
    const secrets = 'secrets' in r ? r.secrets : [];
    list.replaceChildren(...(secrets.length ? secrets.map((s) => item(s, status)) : [h('li', {}, S.noSecrets)]));
  };
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => void load(), 250); });
  app.replaceChildren(header,
    h('p', {}, `${S.detected}: `, h('span', { className: 'badge' }, PORTAL_LABELS[portal] ?? portal)),
    field(S.search, search), list, status);
  void load();
}

function item(s: SecretItem, status: HTMLElement): HTMLLIElement {
  const btn = h('button', { type: 'button', ariaLabel: `${S.fill}: ${s.clientName} (${s.usernameHint})` }, S.fill);
  btn.addEventListener('click', () => { void doFill(s.id, status); });
  return h('li', {}, h('div', {}, h('strong', {}, s.clientName), h('span', {}, `${s.label} · ${s.usernameHint}`)), btn);
}

async function doFill(id: string, status: HTMLElement): Promise<void> {
  const r = await send({ type: 'fill', secretId: id });
  if (r.ok) { status.replaceChildren(msg(S.filled, 'ok')); return; }
  if (r.needsStepUp) { status.replaceChildren(stepUp(id, status)); return; }
  if (r.signedOut) { await render(); return; }
  status.replaceChildren(msg(`${S.fillFailed} (${r.error})`, 'err'));
}

function stepUp(id: string, status: HTMLElement): HTMLFormElement {
  const pw = h('input', { type: 'password', name: 'password', autocomplete: 'current-password' });
  const totp = h('input', { name: 'totp', inputMode: 'numeric', pattern: '[0-9]{6}', maxLength: 6, autocomplete: 'one-time-code' });
  const cancel = h('button', { type: 'button', className: 'secondary' }, S.cancel);
  const out = h('div');
  const form = h('form', {}, h('h1', {}, S.stepUpHeading), msg(S.stepUpHelp), field(S.password, pw), field(S.totp, totp),
    h('div', { className: 'row' }, h('button', { type: 'submit' }, S.confirm), cancel), out);
  cancel.addEventListener('click', () => status.replaceChildren());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const code = totp.value.trim();
      const r = await send(/^\d{6}$/.test(code) ? { type: 'stepUp', totp: code } : { type: 'stepUp', password: pw.value });
      pw.value = ''; totp.value = '';
      if (!r.ok) { out.replaceChildren(msg(S.stepUpFailed, 'err')); return; }
      await doFill(id, status);
    })();
  });
  queueMicrotask(() => pw.focus());
  return form;
}

void render();
