import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Linking } from 'react-native';
import { parseQueue, processQueue, enqueue, type PendingSig, type UploadOutcome } from './logic/sigQueue';
import type { RegisterKind } from './logic/registers';
import { api, apiBase, unwrap, useSession } from './session';
import { getStore, syncNow, useSync } from './sync';

type RNFile = { uri: string; name: string; type: string };

/** Multipart POST with the bearer token; refreshes once on 401 via the typed client (which owns refresh). */
async function postMultipart(path: string, build: () => FormData): Promise<Response> {
  const send = () => fetch(apiBase.replace(/\/$/, '') + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + (useSession.getState().tokens?.accessToken ?? '') }, body: build(),
  });
  let res = await send();
  if (res.status === 401) { await api.GET('/me').catch(() => undefined); res = await send(); }
  return res;
}
const filePart = (f: RNFile) => f as unknown as Blob;

export async function uploadDocument(f: RNFile, meta: { clientId: string; category: string; fy: string; name?: string }): Promise<void> {
  const res = await postMultipart('/documents', () => {
    const fd = new FormData();
    fd.append('file', filePart(f));
    fd.append('clientId', meta.clientId); fd.append('category', meta.category); fd.append('fy', meta.fy);
    if (meta.name) fd.append('name', meta.name);
    return fd;
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
}

export async function openDocument(id: string): Promise<void> {
  const { url } = await unwrap(api.POST('/documents/{id}/download-url', { params: { path: { id } }, body: {} }));
  await Linking.openURL(new URL(url, apiBase.endsWith('/') ? apiBase : apiBase + '/').toString());
}

/** Camera first; falls back to the gallery when camera permission is refused. */
export async function pickImage(source: 'camera' | 'library'): Promise<RNFile | 'denied' | null> {
  if (source === 'camera') {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) return 'denied';
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7 };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const a = r.canceled ? null : r.assets[0];
  if (!a) return null;
  return { uri: a.uri, name: a.fileName ?? `scan-${Date.now()}.jpg`, type: a.mimeType ?? 'image/jpeg' };
}

// ---- pending signature queue (persisted in the encrypted local store's meta table) ----
const QKEY = 'pending_signatures';
let running = false;

export async function loadSigQueue(): Promise<PendingSig[]> { return parseQueue((await getStore()?.getMeta(QKEY)) ?? null); }
async function saveSigQueue(q: PendingSig[]) { await getStore()?.setMeta(QKEY, JSON.stringify(q)); useSync.setState((s) => ({ versions: { ...s.versions, [QKEY]: (s.versions[QKEY] ?? 0) + 1 } })); }

async function uploadSig(s: PendingSig): Promise<UploadOutcome> {
  if (!useSync.getState().online) return 'offline';
  const row = await getStore()?.get(s.kind === 'inward' ? 'inward_entry' : 'outward_entry', s.entryId);
  if (!row || !row.fields.number) return 'not_synced'; // server assigns number on first sync
  try {
    const res = await postMultipart(`/registers/${s.kind}/${s.entryId}/signature`, () => {
      const fd = new FormData(); fd.append('file', filePart({ uri: s.uri, name: 'signature.png', type: 'image/png' })); return fd;
    });
    if (res.ok) return 'ok';
    return res.status === 404 ? 'not_synced' : 'failed';
  } catch { return 'offline'; }
}

/** Queue a captured signature and try to upload straight away. Returns true if it uploaded now. */
export async function submitSignature(kind: RegisterKind, entryId: string, uri: string): Promise<boolean> {
  await saveSigQueue(enqueue(await loadSigQueue(), { kind, entryId, uri }));
  const left = await flushSignatures();
  return !left.some((x) => x.entryId === entryId && x.kind === kind);
}

export async function flushSignatures(): Promise<PendingSig[]> {
  const q = await loadSigQueue();
  if (running || !q.length) return q;
  running = true;
  try {
    const { queue, uploaded } = await processQueue(q, uploadSig);
    // Re-read so captures queued while uploading are not lost.
    const latest = await loadSigQueue();
    const done = new Set(q.map((x) => `${x.kind}:${x.entryId}:${x.addedAt}`));
    const merged = [...queue, ...latest.filter((x) => !done.has(`${x.kind}:${x.entryId}:${x.addedAt}`))];
    await saveSigQueue(merged);
    if (uploaded.length) void syncNow();
    return merged;
  } finally { running = false; }
}

// ---- billing (D72: money records are REST-only; the phone just reads synced headers) ----

/** Downloads the invoice PDF with the bearer token into the cache and hands it to a PDF viewer via a content:// URI. */
export async function openInvoicePdf(id: string, name: string): Promise<void> {
  const target = `${FileSystem.cacheDirectory ?? ''}${name.replace(/[^\w.-]+/g, '_') || 'invoice'}.pdf`;
  const url = apiBase.replace(/\/$/, '') + `/billing/invoices/${id}/pdf`;
  const get = () => FileSystem.downloadAsync(url, target, { headers: { Authorization: 'Bearer ' + (useSession.getState().tokens?.accessToken ?? '') } });
  let res = await get();
  if (res.status === 401) { await api.GET('/me').catch(() => undefined); res = await get(); }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  await Linking.openURL(await FileSystem.getContentUriAsync(res.uri));
}

export type PaymentLinkInfo = { url: string; amountPaise: number; status?: string };

/** The latest live payment link of an invoice, if any (from the invoice detail). */
export async function latestPaymentLink(id: string): Promise<PaymentLinkInfo | null> {
  const d = await unwrap(api.GET('/billing/invoices/{id}', { params: { path: { id } } }));
  const links = (d.paymentLinks ?? []).filter((l) => l.status === 'created' && l.url);
  const l = links[links.length - 1];
  return l ? { url: l.url!, amountPaise: Number(l.amountPaise ?? 0), status: l.status } : null;
}

export async function createPaymentLink(id: string): Promise<PaymentLinkInfo> {
  const r = await unwrap(api.POST('/billing/invoices/{id}/payment-link', { params: { path: { id } } }));
  return { url: r.url, amountPaise: r.amountPaise };
}

export type ReceiptBody = { clientId: string; receivedOn: string; amountPaise: number; tdsPaise: number; tdsSection: string | null; mode: 'cash' | 'bank' | 'upi' | 'cheque' | 'online'; reference: string | null };

/** Allocations omitted ⇒ the server allocates FIFO (TDS first) and returns what it did. */
export async function recordReceipt(body: ReceiptBody) {
  const r = await unwrap(api.POST('/billing/receipts', { body }));
  void syncNow();
  return r;
}

// ---- phase 6: expense receipt photos (D93: receipts are documents the claimant uploaded; bytes never sync) ----

/** Uploads a receipt photo as a firm document (no client) and returns its id for `receiptDocId`. */
export async function uploadReceiptPhoto(f: RNFile, fy: string, category: string): Promise<string> {
  const res = await postMultipart('/documents', () => {
    const fd = new FormData();
    fd.append('file', filePart(f)); fd.append('category', category); fd.append('fy', fy); fd.append('name', f.name);
    return fd;
  });
  const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!res.ok || !body?.id) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body.id;
}
