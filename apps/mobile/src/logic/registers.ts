import { fyLabel, fyStartYear } from '@worko/domain';
import { normalizePhone } from './clients';

export const INWARD_MODES = ['physical', 'email', 'whatsapp', 'courier', 'portal', 'other'] as const;
export const OUTWARD_MODES = ['hand', 'courier', 'email', 'whatsapp', 'post', 'other'] as const;
export type RegisterKind = 'inward' | 'outward';
export const REGISTER_TABLE = { inward: 'inward_entry', outward: 'outward_entry' } as const;

/** Today's date in IST (yyyy-mm-dd), independent of the device time zone. */
export function todayIST(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
export const currentFy = (now: Date = new Date()) => fyLabel(fyStartYear(todayIST(now)));

export type RegisterForm = {
  clientId: string; date?: string; mode: string; party?: string; phone?: string; description: string;
  items?: Array<{ description: string; qty?: number; original?: boolean }>;
  /** inward: returnable; outward: to_be_received_back */
  returnable?: boolean; dueBack?: string; original?: boolean; courierName?: string; trackingNo?: string;
};
export type PatchResult = { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Array<'client' | 'mode' | 'description' | 'date' | 'phone' | 'dueBack'> };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Device-side insert patch. Never includes server-assigned `number` / `fy` / `received_by` / `sent_by`. */
export function buildRegisterPatch(kind: RegisterKind, f: RegisterForm, now: Date = new Date()): PatchResult {
  const errors: Extract<PatchResult, { ok: false }>['errors'] = [];
  const modes: readonly string[] = kind === 'inward' ? INWARD_MODES : OUTWARD_MODES;
  const date = f.date?.trim() || todayIST(now);
  if (!f.clientId) errors.push('client');
  if (!modes.includes(f.mode)) errors.push('mode');
  if (!f.description.trim()) errors.push('description');
  if (!DATE.test(date)) errors.push('date');
  let phone: string | null = null;
  if (f.phone?.trim()) {
    const d = normalizePhone(f.phone);
    if (d.length === 10) phone = `+91${d}`;
    else if (d.length >= 10 && d.length <= 15) phone = `+${d}`;
    else errors.push('phone');
  }
  if (f.dueBack && !DATE.test(f.dueBack)) errors.push('dueBack');
  if (errors.length) return { ok: false, errors };
  const items = (f.items ?? []).filter((i) => i.description.trim())
    .map((i) => ({ description: i.description.trim(), qty: i.qty ?? 1, original: !!i.original }));
  const party = f.party?.trim() || null;
  const patch: Record<string, unknown> = kind === 'inward'
    ? { client_id: f.clientId, received_on: date, mode: f.mode, from_name: party, from_phone: phone, description: f.description.trim(), items,
        returnable: !!f.returnable, due_back: f.returnable ? f.dueBack || null : null }
    : { client_id: f.clientId, sent_on: date, mode: f.mode, to_name: party, to_phone: phone, courier_name: f.courierName?.trim() || null,
        tracking_no: f.trackingNo?.trim() || null, description: f.description.trim(), items, original: !!f.original, to_be_received_back: !!f.returnable };
  return { ok: true, patch };
}

export type EntryItem = { id: string; kind: RegisterKind; number: string | null; date: string; clientId: string; party: string; description: string; mode: string; signed: boolean; key: string };

export function toEntryItems(kind: RegisterKind, rows: Array<{ id: string; deleted?: boolean; fields: Record<string, unknown> }>, clientName: (id: string) => string): EntryItem[] {
  return rows.filter((r) => !r.deleted).map((r) => {
    const f = r.fields; const s = (v: unknown) => (v == null ? '' : String(v));
    const e = { id: r.id, kind, number: f.number ? s(f.number) : null, date: s(kind === 'inward' ? f.received_on : f.sent_on), clientId: s(f.client_id),
      party: s(kind === 'inward' ? f.from_name : f.to_name), description: s(f.description), mode: s(f.mode), signed: !!f.signature_doc_id };
    return { ...e, key: [e.number ?? '', e.party, e.description, clientName(e.clientId)].join('\u0001').toLowerCase() };
  }).sort((a, b) => b.date.localeCompare(a.date) || (b.number ?? '￿').localeCompare(a.number ?? '￿'));
}
export const searchEntries = (items: EntryItem[], q: string, clientId?: string) => {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((e) => (!clientId || e.clientId === clientId) && terms.every((t) => e.key.includes(t)));
};
