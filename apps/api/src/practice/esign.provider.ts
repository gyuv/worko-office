import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * E-signature providers (M12). `mock` is the default; `asp` is a SKELETON for an Aadhaar eSign ASP (ESP-backed) integration.
 * // VERIFY AGAINST OFFICIAL DOCS: ESP/ASP API (CCA eSign API spec), request XML/JSON shapes, signer redirect flow,
 * response signature verification, what identity data comes back. We store only masked identifiers — never an Aadhaar number.
 */
export type EsignSignerIn = { signerId: string; name: string; email: string | null; phone: string | null; order: number };
export type EsignTxnIn = { itemId: string; documentId: string; fileName: string; sha256: string; mode: 'parallel' | 'sequential'; signers: EsignSignerIn[] };
export type EsignEvent = {
  eventId: string; txnId: string; signerRef: string; kind: 'signed' | 'declined' | 'failed'; at: Date | null;
  /** Already masked by the provider (e.g. 'XXXXXXXX1234'); anything with 5+ consecutive digits is discarded. */
  maskedId: string | null; nameAsPerId: string | null;
};
type Headers = Record<string, string | string[] | undefined>;

export interface EsignProvider {
  readonly name: string;
  createTransaction(i: EsignTxnIn): Promise<{ txnId: string; signerUrls: Record<string, string> }>;
  cancel(txnId: string): Promise<void>;
  verifyWebhook(raw: Buffer, headers: Headers): boolean;
  parseWebhook(raw: Buffer): EsignEvent[];
  /** The signed file once every signer is done. */
  fetchSigned(txnId: string, original: Buffer): Promise<Buffer>;
}

const hdr = (h: Headers, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };
const safeEq = (a: string | undefined, b: string) => { if (!a) return false; const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export const DEV_ESIGN_WEBHOOK_SECRET = 'worko-dev-esign-webhook-secret';
export const esignHmac = (secret: string, raw: Buffer) => createHmac('sha256', secret).update(raw).digest('hex');
export const maskedOnly = (v: unknown) => (typeof v === 'string' && v.length <= 40 && !/[0-9]{5,}/.test(v) ? v : null);

/** Dev/test provider: deterministic txn ids, `x-worko-signature` HMAC webhooks, signed file = original + a trailer comment. */
export class MockEsignProvider implements EsignProvider {
  readonly name = 'mock';
  /** Test hook: document ids whose transaction creation fails (once per entry). */
  readonly failDocs = new Set<string>();
  readonly cancelled: string[] = [];
  private secret = () => process.env.ESIGN_WEBHOOK_SECRET || DEV_ESIGN_WEBHOOK_SECRET;
  async createTransaction(i: EsignTxnIn) {
    if (this.failDocs.delete(i.documentId)) throw new Error('provider_unavailable');
    const txnId = `mock-${i.itemId}`;
    return { txnId, signerUrls: Object.fromEntries(i.signers.map((s) => [s.signerId, `https://esign.mock.invalid/sign/${txnId}/${s.signerId}`])) };
  }
  async cancel(txnId: string) { this.cancelled.push(txnId); }
  verifyWebhook(raw: Buffer, h: Headers) { return safeEq(hdr(h, 'x-worko-signature'), esignHmac(this.secret(), raw)); }
  parseWebhook(raw: Buffer): EsignEvent[] {
    const b = JSON.parse(raw.toString('utf8')) as { events?: Array<Record<string, unknown>> };
    return (b.events ?? []).flatMap((e): EsignEvent[] => {
      if (typeof e.id !== 'string' || typeof e.txn !== 'string' || typeof e.signer !== 'string' || !['signed', 'declined', 'failed'].includes(String(e.type))) return [];
      const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at) : null;
      return [{ eventId: e.id, txnId: e.txn, signerRef: e.signer, kind: e.type as 'signed', at, maskedId: maskedOnly(e.maskedId), nameAsPerId: typeof e.name === 'string' ? e.name.slice(0, 200) : null }];
    });
  }
  async fetchSigned(txnId: string, original: Buffer) { return Buffer.concat([original, Buffer.from(`\n% worko-mock-esign ${txnId}\n`)]); }
}

/** Aadhaar eSign via an ASP — SKELETON only (ESIGN_PROVIDER=asp, ESIGN_ASP_URL, ESIGN_ASP_ID, ESIGN_ASP_KEY). // VERIFY AGAINST OFFICIAL DOCS */
export class AspEsignProvider implements EsignProvider {
  readonly name = 'asp';
  private cfg() {
    const url = process.env.ESIGN_ASP_URL; const id = process.env.ESIGN_ASP_ID; const key = process.env.ESIGN_ASP_KEY;
    if (!url || !id || !key) throw new Error('ESIGN_ASP_URL/ID/KEY not configured');
    return { url, id, key };
  }
  async createTransaction(i: EsignTxnIn): Promise<{ txnId: string; signerUrls: Record<string, string> }> {
    const c = this.cfg();
    // Sends only the document hash (ESP signs the hash; the file never leaves us) — VERIFY flow with the ASP.
    const res = await fetch(`${c.url}/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-asp-id': c.id, authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ reference: i.itemId, hash: i.sha256, hashAlgorithm: 'SHA256', signers: i.signers.map((s) => ({ ref: s.signerId, name: s.name, order: s.order })), mode: i.mode }) });
    if (!res.ok) throw new Error(`asp_${res.status}`);
    const j = (await res.json()) as { id: string; signers: Array<{ ref: string; url: string }> };
    return { txnId: j.id, signerUrls: Object.fromEntries(j.signers.map((s) => [s.ref, s.url])) };
  }
  async cancel(txnId: string) { const c = this.cfg(); await fetch(`${c.url}/transactions/${encodeURIComponent(txnId)}/cancel`, { method: 'POST', headers: { 'x-asp-id': c.id, authorization: `Bearer ${c.key}` } }); }
  verifyWebhook(raw: Buffer, h: Headers) { const k = process.env.ESIGN_WEBHOOK_SECRET || ''; return !!k && k !== DEV_ESIGN_WEBHOOK_SECRET && safeEq(hdr(h, 'x-asp-signature'), esignHmac(k, raw)); }
  parseWebhook(raw: Buffer): EsignEvent[] {
    const b = JSON.parse(raw.toString('utf8')) as { id?: string; transaction?: string; signer?: string; status?: string; timestamp?: string; maskedAadhaar?: string; name?: string };
    if (!b.id || !b.transaction || !b.signer || !['signed', 'declined', 'failed'].includes(String(b.status))) return [];
    return [{ eventId: b.id, txnId: b.transaction, signerRef: b.signer, kind: b.status as 'signed', at: b.timestamp ? new Date(b.timestamp) : null, maskedId: maskedOnly(b.maskedAadhaar), nameAsPerId: b.name ?? null }];
  }
  async fetchSigned(txnId: string): Promise<Buffer> {
    const c = this.cfg();
    const res = await fetch(`${c.url}/transactions/${encodeURIComponent(txnId)}/document`, { headers: { 'x-asp-id': c.id, authorization: `Bearer ${c.key}` } });
    if (!res.ok) throw new Error(`asp_${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

export const ESIGN_PROVIDERS = 'ESIGN_PROVIDERS';
export const esignProvider = () => process.env.ESIGN_PROVIDER || 'mock';
export const esignProvidersFactory = (): Record<string, EsignProvider> => ({ mock: new MockEsignProvider(), asp: new AspEsignProvider() });
/** Mock webhooks exist only outside production while the mock provider is selected (same lockdown as D75/D100). */
export const mockEsignAllowed = () => process.env.NODE_ENV !== 'production' && esignProvider() === 'mock';
export function assertEsignConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  if (esignProvider() === 'mock') return; // requests are refused instead (no mock signing in production)
  if (!process.env.ESIGN_WEBHOOK_SECRET || process.env.ESIGN_WEBHOOK_SECRET === DEV_ESIGN_WEBHOOK_SECRET) throw new Error('ESIGN_WEBHOOK_SECRET must be set in production');
}
