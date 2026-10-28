import type { ClientFacts, Extension } from '@worko/rules';
import type { Tx } from '../db/db.service.js';
import { ymd } from '../tasks/scope.js';

/**
 * Facts the rule predicates evaluate, derived from the client: its compliance profile first (explicit answers win),
 * then registrations (GSTIN ⇒ gstRegistered, TAN ⇒ hasTan, PF/ESI) and the entity type.
 */
export function factsOf(c: Record<string, unknown>, regKinds: string[]): ClientFacts {
  const prof = (c.compliance_profile ?? {}) as Record<string, unknown>;
  const has = (k: string) => regKinds.includes(k);
  const gst = prof.gstRegistered ?? has('GSTIN');
  return {
    ...prof,
    id: c.id as string,
    entityType: c.entity_type,
    gstRegistered: gst,
    gstFiling: prof.gstFiling ?? (gst ? 'MONTHLY' : null),
    hasTan: prof.hasTan ?? (!!c.tan || has('TAN')),
    pfRegistered: prof.pfRegistered ?? has('PF'),
    esiRegistered: prof.esiRegistered ?? has('ESI'),
    taxAudit: prof.taxAudit ?? false,
  };
}

/** Clients (with names + registration kinds) matching `where` over alias `c`. */
export async function loadClientsWithFacts(tx: Tx, where: string, params: unknown[]) {
  const rows = (await tx.query(
    `SELECT c.*, ARRAY(SELECT r.kind FROM client_registration r WHERE r.client_id = c.id AND r.deleted_at IS NULL) AS reg_kinds
     FROM client c WHERE c.deleted_at IS NULL AND c.status = 'active' AND ${where} ORDER BY lower(c.name), c.id`, params)).rows;
  return rows.map((r) => ({ row: r as Record<string, unknown>, facts: factsOf(r, r.reg_kinds as string[]) }));
}

export async function approvedExtensions(tx: Tx): Promise<Extension[]> {
  return (await tx.query(`SELECT * FROM rule_extension WHERE status = 'approved' ORDER BY approved_at`)).rows.map((e) => ({
    id: e.id, ruleId: e.rule_id, periodKey: e.period_key, newDueDate: ymd(e.new_due_date)!, scope: e.scope ?? {}, notification: e.notification ?? undefined,
  }));
}

/** FY start year of a period key: '2026-09' → 2026; '2027-02' → 2026; 'FY2026-27-Q1' / 'FY2026-27' → 2026. */
export function fyOfPeriodKey(key: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) { const y = Number(m[1]); return Number(m[2]) >= 4 ? y : y - 1; }
  const f = /^FY(\d{4})-\d{2}/.exec(key);
  return f ? Number(f[1]) : null;
}
export const fyOfDate = (d: string) => { const [y, m] = d.split('-').map(Number) as [number, number]; return m >= 4 ? y : y - 1; };

/** Today's date in IST as YYYY-MM-DD (only for defaults; tests pass explicit dates). */
export const todayIst = (now = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
