import { Logger } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// ---------------- Client messaging (follow-ups, "send invoice") ----------------

export type ClientMessage = { tenantId: string; channel: 'email' | 'whatsapp'; to: string; subject: string; text: string; invoiceId: string };
export interface ClientMessenger { send(m: ClientMessage): Promise<{ status: 'sent' | 'failed'; ref?: string; error?: string }> }
export const CLIENT_MESSENGER = 'CLIENT_MESSENGER';

/**
 * Mock email/WhatsApp sender (default; tests read `outbox`). Real adapters (SMTP/SES, Meta Cloud API / Gupshup with approved
 * templates) plug in behind this interface — // VERIFY AGAINST OFFICIAL DOCS (WhatsApp template rules, DLT for SMS).
 * Messages carry the invoice number, amount and a signed link — never the PDF or other client data.
 */
export class MockMessenger implements ClientMessenger {
  private log = new Logger('Messenger');
  readonly outbox: ClientMessage[] = [];
  async send(m: ClientMessage) {
    this.outbox.push(m);
    if (process.env.NODE_ENV !== 'test') this.log.log(`${m.channel} to ${m.to.replace(/.(?=.{4})/g, '•')}: ${m.subject}`);
    return { status: 'sent' as const, ref: `mock-${this.outbox.length}` };
  }
}

// ---------------- Payment links ----------------

export type LinkRequest = { tenantId: string; invoiceId: string; invoiceNumber: string; amountPaise: number; customer: { name: string; email?: string | null; phone?: string | null } };
export type PaymentEvent = { eventId: string; type: string; paid: boolean; linkId: string | null; paymentId: string | null; amountPaise: number };
export interface PaymentProvider {
  readonly name: string;
  createLink(r: LinkRequest): Promise<{ linkId: string; url: string }>;
  /** Signature over the exact raw request body. */
  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parse(raw: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent | null;
}
export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';

const h = (headers: Record<string, string | string[] | undefined>, k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
export function hmacHex(secret: string, raw: Buffer) { return createHmac('sha256', secret).update(raw).digest('hex'); }
function safeEq(a: string | undefined, b: string) {
  if (!a) return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Local/dev provider: links point at a fake checkout; webhooks are signed with PAYMENT_WEBHOOK_SECRET (header `x-worko-signature`). */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private secret = () => process.env.PAYMENT_WEBHOOK_SECRET ?? 'worko-dev-webhook-secret';
  async createLink(r: LinkRequest) {
    const linkId = `plink_${createHash('sha256').update(`${r.tenantId}:${r.invoiceId}:${r.amountPaise}:${Date.now()}`).digest('hex').slice(0, 14)}`;
    return { linkId, url: `https://pay.example.invalid/${linkId}` };
  }
  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>) { return safeEq(h(headers, 'x-worko-signature'), hmacHex(this.secret(), raw)); }
  parse(raw: Buffer): PaymentEvent | null {
    const b = JSON.parse(raw.toString('utf8')) as { id?: string; type?: string; linkId?: string; paymentId?: string; amountPaise?: number };
    if (!b.id || !b.type) return null;
    return { eventId: b.id, type: b.type, paid: b.type === 'payment.captured', linkId: b.linkId ?? null, paymentId: b.paymentId ?? null, amountPaise: Number(b.amountPaise ?? 0) };
  }
}

/**
 * Razorpay Payment Links — SKELETON. // VERIFY AGAINST OFFICIAL DOCS (Razorpay Payment Links API + webhooks):
 * endpoint/body of `POST /v1/payment_links`, the `payment_link.paid` payload shape, the `x-razorpay-signature`
 * (hex HMAC-SHA256 of the raw body with the webhook secret) and `x-razorpay-event-id` headers. See KNOWN_GAPS.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';
  async createLink(r: LinkRequest) {
    const id = process.env.RAZORPAY_KEY_ID; const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!id || !secret) throw new Error('Razorpay is not configured');
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
      body: JSON.stringify({ amount: r.amountPaise, currency: 'INR', reference_id: r.invoiceId, description: `Invoice ${r.invoiceNumber}`,
        customer: { name: r.customer.name, email: r.customer.email ?? undefined, contact: r.customer.phone ?? undefined }, notify: { sms: false, email: false },
        notes: { tenant_id: r.tenantId, invoice_id: r.invoiceId } }),
    });
    if (!res.ok) throw new Error(`Razorpay ${res.status}`);
    const j = await res.json() as { id: string; short_url: string };
    return { linkId: j.id, url: j.short_url };
  }
  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    return !!secret && safeEq(h(headers, 'x-razorpay-signature'), hmacHex(secret, raw));
  }
  parse(raw: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent | null {
    const b = JSON.parse(raw.toString('utf8')) as { event?: string; payload?: { payment_link?: { entity?: { id?: string } }; payment?: { entity?: { id?: string; amount?: number } } } };
    const eventId = h(headers, 'x-razorpay-event-id');
    if (!eventId || !b.event) return null;
    return { eventId, type: b.event, paid: b.event === 'payment_link.paid', linkId: b.payload?.payment_link?.entity?.id ?? null,
      paymentId: b.payload?.payment?.entity?.id ?? null, amountPaise: Number(b.payload?.payment?.entity?.amount ?? 0) };
  }
}

export const paymentProvidersFactory = (): Record<string, PaymentProvider> => ({ mock: new MockPaymentProvider(), razorpay: new RazorpayProvider() });
export const defaultPaymentProvider = () => process.env.PAYMENT_PROVIDER ?? 'mock';

// ---------------- Signed invoice links (sent to clients instead of attachments) ----------------

const linkKey = () => createHash('sha256').update(`invoice-link:${process.env.JWT_SIGNING_KEY ?? 'worko-dev-only-signing-key'}`).digest();

export function signInvoiceLink(tenantId: string, invoiceId: string, expiresAt: Date): string {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, i: invoiceId, e: Math.floor(expiresAt.getTime() / 1000) })).toString('base64url');
  return `${payload}.${createHmac('sha256', linkKey()).update(payload).digest('base64url')}`;
}
export function verifyInvoiceLink(token: string, now = new Date()): { tenantId: string; invoiceId: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = createHmac('sha256', linkKey()).update(payload).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { t: string; i: string; e: number };
    return p.e * 1000 > now.getTime() ? { tenantId: p.t, invoiceId: p.i } : null;
  } catch { return null; }
}
export const publicBase = () => process.env.PUBLIC_API_URL ?? 'http://localhost:3000/v1';
