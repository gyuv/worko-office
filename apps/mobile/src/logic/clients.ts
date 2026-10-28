/** Pure client list logic over synced local rows (snake_case DB columns). No React Native imports. */
export type RowLike = { id: string; deleted?: boolean; fields: Record<string, unknown> };

export type ClientItem = {
  id: string; name: string; tradeName: string; fileNo: string; pan: string; phone: string; email: string;
  status: string; gstins: string[]; key: string;
};

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Indian phone → 10 local digits (drops +91 / 91 / leading 0). Non-Indian/short numbers return all digits. */
export function normalizePhone(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/** Build list items once (search key precomputed) so filtering thousands of rows stays cheap. */
export function toClientItems(clients: RowLike[], registrations: RowLike[] = []): ClientItem[] {
  const gst = new Map<string, string[]>();
  for (const r of registrations) {
    if (r.deleted || str(r.fields.kind) !== 'GSTIN') continue;
    const cid = str(r.fields.client_id);
    gst.set(cid, [...(gst.get(cid) ?? []), str(r.fields.number).toUpperCase()]);
  }
  return clients.filter((c) => !c.deleted).map((c) => {
    const f = c.fields;
    const item = {
      id: c.id, name: str(f.name), tradeName: str(f.trade_name), fileNo: str(f.file_no), pan: str(f.pan).toUpperCase(),
      phone: str(f.phone), email: str(f.email), status: str(f.status) || 'active', gstins: gst.get(c.id) ?? [],
    };
    const key = [item.name, item.tradeName, item.fileNo, item.pan, item.email, ...item.gstins].join('\u0001').toLowerCase()
      + '\u0001' + normalizePhone(item.phone);
    return { ...item, key };
  }).sort(compareClients);
}

export function compareClients(a: ClientItem, b: ClientItem): number {
  return a.name.localeCompare(b.name, 'en-IN', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

/** Phone-shaped query ("+91 98450", "080-2222") → digits as stored in the normalised key. */
function phoneTerm(q: string): string | null {
  const t = q.trim();
  if (!/^\+?[\d\s-]+$/.test(t)) return null;
  let d = t.replace(/\D/g, '');
  if (d.length < 3) return null;
  if (t.startsWith('+91')) d = d.slice(2);
  else d = normalizePhone(d);
  return d;
}

/** All whitespace-separated terms must match; a phone-shaped query is matched as one normalised number. */
export function searchClients(items: ClientItem[], query: string, status?: string): ClientItem[] {
  const phone = phoneTerm(query);
  const terms = phone ? [phone] : query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((c) => (!status || c.status === status) && terms.every((t) => c.key.includes(t)));
}
