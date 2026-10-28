import { NotFoundException } from '@nestjs/common';
import {
  can, capCheck, clientCtx, commSettingsSchema, defaultCommSettings, rateFor, smsSegments, type CommChannel, type CommRate, type CommSettings, type TemplateCategory,
} from '@worko/domain';
import { nextAllowed } from '@worko/notify';
import type { RequestActor } from '../auth/context.js';
import { visibilityOf } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';

export async function loadCommSettings(tx: Tx): Promise<CommSettings> {
  const s = (await tx.query('SELECT settings FROM comm_settings LIMIT 1')).rows[0]?.settings;
  const p = commSettingsSchema.safeParse(s ?? {});
  return p.success ? p.data : defaultCommSettings();
}

/** Effective rates: a tenant override replaces the card for that channel × category (D101). */
export async function loadRates(tx: Tx): Promise<Array<CommRate & { source: 'card' | 'firm'; verified: boolean; note: string | null }>> {
  const iso = (d: unknown) => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : d === null ? null : String(d));
  const firm = (await tx.query('SELECT channel, category, paise, effective_from, effective_to, note FROM comm_rate')).rows;
  const card = (await tx.query('SELECT channel, category, paise, effective_from, effective_to, verified, note FROM comm_rate_card')).rows;
  const keys = new Set(firm.map((r) => `${r.channel}:${r.category}`));
  return [
    ...firm.map((r) => ({ channel: r.channel, category: r.category, paise: Number(r.paise), effectiveFrom: iso(r.effective_from)!, effectiveTo: iso(r.effective_to), source: 'firm' as const, verified: true, note: r.note })),
    ...card.filter((r) => !keys.has(`${r.channel}:${r.category}`)).map((r) => ({ channel: r.channel, category: r.category, paise: Number(r.paise), effectiveFrom: iso(r.effective_from)!, effectiveTo: iso(r.effective_to), source: 'card' as const, verified: r.verified, note: r.note })),
  ];
}

export const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
export const istMonth = (d: Date) => istDay(d).slice(0, 7);
/** [start, end) instants of an IST calendar month. */
export function monthRange(month: string): [Date, Date] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1) - 330 * 60_000);
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 330 * 60_000);
  return [start, end];
}
export const SPENT_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read'];
export async function usedPaise(tx: Tx, channel: CommChannel, month: string): Promise<number> {
  const [s, e] = monthRange(month);
  return Number((await tx.query(`SELECT COALESCE(sum(cost_paise), 0) AS p FROM comm_message WHERE direction = 'out' AND channel = $1 AND occurred_at >= $2 AND occurred_at < $3
    AND status = ANY($4) AND deleted_at IS NULL`, [channel, s, e, SPENT_STATUSES])).rows[0].p);
}

export type ConsentRow = { status: 'opted_in' | 'opted_out' } | undefined;
export async function consentOf(tx: Tx, channel: CommChannel, address: string): Promise<ConsentRow> {
  return (await tx.query('SELECT status FROM comm_consent WHERE channel = $1 AND address = $2', [channel, address])).rows[0];
}
/** Firm policy (D99): marketing needs an opt-in; transactional/utility only respect an opt-out (and an opt-in if the firm requires it). */
export function consentError(c: ConsentRow, category: TemplateCategory, s: CommSettings): 'opted_out' | 'not_opted_in' | null {
  if (category === 'marketing') return c?.status === 'opted_in' ? null : c?.status === 'opted_out' ? 'opted_out' : 'not_opted_in';
  if (c?.status === 'opted_out' && s.consent.optOutBlocksTransactional) return 'opted_out';
  if (!c && s.consent.transactionalRequiresOptIn) return 'not_opted_in';
  return null;
}

export function unitCost(rates: CommRate[], channel: CommChannel, category: TemplateCategory, text: string, onDate: string): number {
  const r = rateFor(rates, channel, category, onDate) ?? 0;
  return channel === 'sms' ? r * smsSegments(text) : r;
}

/** Quiet hours shift the send time; client-facing only (D99). */
export function sendTimeFor(s: CommSettings, category: TemplateCategory, now: Date): Date {
  if (!s.quietHours || (s.quietHours.appliesTo === 'marketing' && category !== 'marketing')) return now;
  return nextAllowed(now, { start: s.quietHours.start, end: s.quietHours.end });
}

export type SendCheck = { error: 'opted_out' | 'not_opted_in' | 'over_cap' | null; sendAt: Date; costPaise: number; capWarning: boolean };
/** Consent → quiet hours → cost → monthly cap, in that order (D99/D101). `pendingPaise` = spend not yet in comm_message (a running batch). */
export async function checkSend(tx: Tx, s: CommSettings, rates: CommRate[], i: { channel: CommChannel; address: string; category: TemplateCategory; text: string; now: Date; pendingPaise?: number }): Promise<SendCheck> {
  const sendAt = sendTimeFor(s, i.category, i.now);
  const costPaise = unitCost(rates, i.channel, i.category, i.text, istDay(i.now));
  const ce = consentError(await consentOf(tx, i.channel, i.address), i.category, s);
  if (ce) return { error: ce, sendAt, costPaise, capWarning: false };
  const cap = capCheck((await usedPaise(tx, i.channel, istMonth(i.now))) + (i.pendingPaise ?? 0), costPaise, s.caps.monthlyPaise[i.channel], s.caps.mode);
  return { error: cap.allowed ? null : 'over_cap', sendAt, costPaise, capWarning: cap.warn };
}

/** Client row visible to the actor for module × action, else 404 (CLAUDE.md: invisible rows answer 404). */
export async function visibleClient(tx: Tx, a: RequestActor, clientId: string, action: 'view' | 'create' | 'edit' = 'view', module: 'communication' | 'clients' = 'communication') {
  const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0];
  if (!c || !can(a, 'clients', 'view', clientCtx(visibilityOf(c))) || !can(a, module, action, clientCtx(visibilityOf(c)))) throw new NotFoundException();
  return c as Record<string, unknown> & { id: string; name: string; email: string | null; phone: string | null; partner_id: string | null; manager_id: string | null };
}

/**
 * Inbound matching (D102): an address matches a client through a contact's phone/WhatsApp/email or the client's own.
 * Indian numbers compare on the last 10 digits (stored numbers vary in format). One client → matched; several → ambiguous.
 */
export async function matchAddress(tx: Tx, channel: CommChannel, address: string): Promise<{ clientId: string | null; contactId: string | null; ambiguous: boolean }> {
  let rows: Array<{ client_id: string; contact_id: string | null }>;
  if (channel === 'email') {
    rows = (await tx.query(`SELECT ct.client_id, ct.id AS contact_id FROM contact ct JOIN client c ON c.id = ct.client_id AND c.deleted_at IS NULL
        WHERE ct.deleted_at IS NULL AND lower(ct.email) = $1
      UNION ALL SELECT c.id, NULL FROM client c WHERE c.deleted_at IS NULL AND lower(c.email) = $1`, [address])).rows;
  } else {
    const digits = address.replace(/\D/g, '');
    const indian = digits.startsWith('91') && digits.length === 12;
    const key = indian ? digits.slice(2) : digits;
    const m = (col: string) => indian ? `right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10) = $1 AND length(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g')) >= 10`
      : `regexp_replace(coalesce(${col}, ''), '\\D', '', 'g') = $1`;
    rows = (await tx.query(`SELECT ct.client_id, ct.id AS contact_id FROM contact ct JOIN client c ON c.id = ct.client_id AND c.deleted_at IS NULL
        WHERE ct.deleted_at IS NULL AND (${m('ct.whatsapp')} OR ${m('ct.phone')})
      UNION ALL SELECT c.id, NULL FROM client c WHERE c.deleted_at IS NULL AND ${m('c.phone')}`, [key])).rows;
  }
  const clients = [...new Set(rows.map((r) => r.client_id))];
  if (clients.length !== 1) return { clientId: null, contactId: null, ambiguous: clients.length > 1 };
  return { clientId: clients[0]!, contactId: rows.find((r) => r.contact_id)?.contact_id ?? null, ambiguous: false };
}

/** The address a client is reached at on a channel: the chosen (else primary, else first) contact, then the client's own. */
export async function addressFor(tx: Tx, clientId: string, channel: CommChannel, contactId?: string | null): Promise<{ address: string | null; contactId: string | null; contactName: string | null }> {
  const ct = (await tx.query(`SELECT id, name, email, phone, whatsapp FROM contact WHERE client_id = $1 AND deleted_at IS NULL ${contactId ? 'AND id = $2' : ''}
    ORDER BY is_primary DESC, id LIMIT 1`, contactId ? [clientId, contactId] : [clientId])).rows[0];
  if (contactId && !ct) throw new NotFoundException('Contact not found');
  const c = (await tx.query('SELECT email, phone FROM client WHERE id = $1', [clientId])).rows[0];
  const raw = channel === 'email' ? ct?.email ?? c?.email : channel === 'whatsapp' ? ct?.whatsapp ?? ct?.phone ?? c?.phone : ct?.phone ?? c?.phone;
  return { address: raw ?? null, contactId: ct?.id ?? null, contactName: ct?.name ?? null };
}

export const firmName = async (tx: Tx) => String((await tx.query('SELECT name FROM tenant WHERE id = current_tenant()')).rows[0]?.name ?? '');
