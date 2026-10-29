import { isScanEvent, SCAN_WINDOW_DAYS, type EventContext } from '@worko/domain';
import type { Tx } from '../db/db.service.js';
import { ymd } from '../practice/common.js';

/** An outbox row (or a synthesised one for dry-runs). */
export type EventRow = { id: string | null; type: string; entity_type: string; entity_id: string; client_id: string | null; payload: Record<string, unknown>; causation: unknown; occurred_at: Date | string | null };

const istDate = (d: unknown) => (d instanceof Date ? new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10) : null);
const diffDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const one = async (tx: Tx, sql: string, id: unknown) => (id ? (await tx.query(sql, [id])).rows[0] ?? null : null);

export const clientSection = (c: Record<string, unknown>) => ({
  id: c.id, name: c.name, entityType: c.entity_type, status: c.status, groupIds: c.group_ids ?? [], tags: c.tags ?? [], branchId: c.branch_id ?? null,
  portalEnabled: !!c.portal_enabled, partnerId: c.partner_id ?? null, managerId: c.manager_id ?? null,
});
const taskSection = (t: Record<string, unknown>, from?: unknown) => ({
  id: t.id, title: t.title, status: t.status, fromStatus: from ?? null, priority: t.priority, serviceKey: t.service_key ?? null, statutoryDue: ymd(t.statutory_due),
  actBy: ymd(t.act_by), assigneeId: t.assignee_id ?? null, managerId: t.manager_id ?? null, reviewerId: t.reviewer_id ?? null, source: t.source, periodLabel: t.period_label ?? null,
  checks: t.checks ?? [], version: t.version,
});
const TASK_SQL = 'SELECT t.*, st.key AS service_key FROM task t LEFT JOIN service_type st ON st.id = t.service_type_id WHERE t.id = $1 AND t.deleted_at IS NULL';

/**
 * Typed condition context for an event (CONTEXT_FIELDS in @worko/domain). Read straight from the tables: the context is
 * data for conditions; every action still goes through a service with the automation actor's permissions.
 * Returns null when the entity is gone.
 */
export async function buildContext(tx: Tx, ev: EventRow, today: string): Promise<EventContext | null> {
  const p = ev.payload ?? {};
  const due = typeof p.due === 'string' ? p.due : null;
  const daysUntil = due ? diffDays(today, due) : null;
  const ctx: EventContext = { event: { type: ev.type, daysUntil, daysOverdue: daysUntil !== null && daysUntil < 0 ? -daysUntil : null, occurredAt: ev.occurred_at, payload: p } as EventContext['event'], entity: { type: ev.entity_type, id: ev.entity_id } };
  let clientId = ev.client_id;
  const id = ev.entity_id;
  switch (ev.entity_type) {
    case 'task': { const t = await one(tx, TASK_SQL, id); if (!t) return null; ctx.task = taskSection(t, p.from); clientId ??= t.client_id; break; }
    case 'invoice': {
      const i = await one(tx, 'SELECT * FROM invoice WHERE id = $1', id); if (!i) return null;
      ctx.invoice = { id: i.id, number: i.number, status: i.status, totalPaise: Number(i.total_paise), balancePaise: Number(i.balance_paise), balanceRupees: (Number(i.balance_paise) / 100).toFixed(2), dueDate: ymd(i.due_date) };
      clientId ??= i.client_id; break;
    }
    case 'receipt': { const r = await one(tx, 'SELECT * FROM receipt WHERE id = $1', id); if (!r) return null; ctx.receipt = { id: r.id, amountPaise: Number(r.amount_paise), receivedOn: ymd(r.received_on) }; clientId ??= r.client_id; break; }
    case 'document': {
      const d = await one(tx, 'SELECT * FROM document WHERE id = $1 AND deleted_at IS NULL', id); if (!d) return null;
      ctx.document = { id: d.id, name: d.name, source: d.source, category: d.category, fy: d.fy ?? null }; clientId ??= d.client_id; break;
    }
    case 'pbc': case 'pbc_item': {
      const i = await one(tx, 'SELECT * FROM pbc_item WHERE id = $1 AND deleted_at IS NULL', id); if (!i) return null;
      ctx.pbc = { id: i.id, title: i.title, status: i.status, dueDate: ymd(i.due_date), engagementId: i.engagement_id }; clientId ??= i.client_id; break;
    }
    case 'notice': {
      const n = await one(tx, 'SELECT * FROM notice WHERE id = $1 AND deleted_at IS NULL', id); if (!n) return null;
      ctx.notice = noticeSection(n); clientId ??= n.client_id;
      const t = await one(tx, TASK_SQL, n.task_id); if (t) ctx.task = taskSection(t);
      break;
    }
    case 'hearing': case 'notice_hearing': {
      const h = await one(tx, 'SELECT * FROM notice_hearing WHERE id = $1 AND deleted_at IS NULL', id); if (!h) return null;
      ctx.hearing = { id: h.id, date: istDate(h.starts_at), startsAt: h.starts_at, prepDone: !!h.prep_done, ownerId: h.owner_id ?? null, venue: h.venue ?? null, status: h.status };
      const n = await one(tx, 'SELECT * FROM notice WHERE id = $1', h.notice_id); if (n) { ctx.notice = noticeSection(n); const t = await one(tx, TASK_SQL, n.task_id); if (t) ctx.task = taskSection(t); }
      clientId ??= h.client_id; break;
    }
    case 'dsc': {
      const d = await one(tx, 'SELECT * FROM dsc WHERE id = $1 AND deleted_at IS NULL', id); if (!d) return null;
      ctx.dsc = { id: d.id, holderName: d.holder_name, holderKind: d.holder_kind, validTo: ymd(d.valid_to), dscClass: d.dsc_class }; clientId ??= d.client_id; break;
    }
    case 'licence': {
      const l = await one(tx, 'SELECT * FROM licence WHERE id = $1 AND deleted_at IS NULL', id); if (!l) return null;
      ctx.licence = { id: l.id, licenceType: l.licence_type, validTo: ymd(l.renewal_due ?? l.valid_to), number: l.number ?? null }; clientId ??= l.client_id; break;
    }
    case 'lead': {
      const l = await one(tx, 'SELECT * FROM lead WHERE id = $1 AND deleted_at IS NULL', id); if (!l) return null;
      ctx.lead = leadSection(l, p.from); clientId ??= l.client_id; break;
    }
    case 'proposal': {
      const pr = await one(tx, 'SELECT * FROM proposal WHERE id = $1 AND deleted_at IS NULL', id); if (!pr) return null;
      ctx.proposal = { id: pr.id, number: pr.number, title: pr.title, status: pr.status };
      const l = await one(tx, 'SELECT * FROM lead WHERE id = $1', pr.lead_id); if (l) ctx.lead = leadSection(l);
      clientId ??= (pr.conversion as { clientId?: string } | null)?.clientId ?? null; break;
    }
    case 'automation_rule': break; // schedule trigger: firm-level, no entity context
    default: return null;
  }
  if (clientId) { const c = await one(tx, 'SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', clientId); if (c) ctx.client = clientSection(c); }
  return ctx;
}
const noticeSection = (n: Record<string, unknown>) => ({ id: n.id, title: n.title, authority: n.authority, level: n.level, section: n.section ?? null, demandPaise: Number(n.demand_paise ?? 0), responseDue: ymd(n.response_due), assigneeId: n.assignee_id ?? null, taskId: n.task_id ?? null });
const leadSection = (l: Record<string, unknown>, from?: unknown) => ({ id: l.id, name: l.name, stage: l.stage, fromStage: from ?? null, source: l.source, expectedValuePaise: Number(l.expected_value_paise ?? 0), ownerId: l.owner_id ?? null });

// ---------- Scans (time-based events) ----------
type Scan = { et: string; from: string; due: string; live: string; ahead: boolean };
/** Eligible rows per scan event: `due` is the date the event is about (statutory due, expiry, hearing day). */
export const SCANS: Record<string, Scan> = {
  'task.overdue': { et: 'task', from: 'task x', due: 'x.statutory_due', live: `x.deleted_at IS NULL AND x.outcome IS NULL AND x.status NOT IN ('done','cancelled')`, ahead: false },
  'compliance.due_soon': { et: 'task', from: 'task x', due: 'x.statutory_due', live: `x.deleted_at IS NULL AND x.outcome IS NULL AND x.status NOT IN ('done','cancelled') AND x.client_id IS NOT NULL`, ahead: true },
  'invoice.overdue': { et: 'invoice', from: 'invoice x', due: 'x.due_date', live: `x.kind = 'invoice' AND x.status IN ('issued','partially_paid') AND x.balance_paise > 0 AND x.deleted_at IS NULL`, ahead: false },
  'pbc.overdue': { et: 'pbc', from: 'pbc_item x', due: 'x.due_date', live: `x.deleted_at IS NULL AND x.status IN ('requested','rejected')`, ahead: false },
  'hearing.upcoming': { et: 'hearing', from: 'notice_hearing x', due: `(x.starts_at AT TIME ZONE 'Asia/Kolkata')::date`, live: `x.deleted_at IS NULL AND x.status = 'scheduled'`, ahead: true },
  'dsc.expiring': { et: 'dsc', from: 'dsc x', due: 'x.valid_to', live: 'x.deleted_at IS NULL', ahead: true },
  'licence.expiring': { et: 'licence', from: 'licence x', due: 'COALESCE(x.renewal_due, x.valid_to)', live: `x.deleted_at IS NULL AND x.status IN ('active','renewal_in_progress')`, ahead: true },
};
/** SELECT of (et, id, client_id, due) for a scan as of $1 (today); window $2 days; optional extra filter. */
export function scanSelect(type: string, extra = '', limit?: number): string {
  const s = SCANS[type]!;
  const win = s.ahead ? `${s.due} BETWEEN $1::date AND $1::date + $2::int` : `${s.due} < $1::date`;
  return `SELECT '${s.et}'::text AS et, x.id, x.client_id, to_char(${s.due}, 'YYYY-MM-DD') AS due FROM ${s.from} WHERE ${s.live} AND ${s.due} IS NOT NULL AND ${win}${extra} ORDER BY ${s.due}${limit ? ` LIMIT ${Number(limit)}` : ''}`;
}
export const subjectKeyOf = (et: string, id: string, due: string) => `${et}:${id}:${due}`;

// ---------- Dry-run candidates for change events ----------
const RECENT: Record<string, string> = {
  'task.created': `SELECT 'task' AS et, id, client_id, jsonb_build_object('status', status) AS payload FROM task WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  'task.status_changed': `SELECT 'task' AS et, id, client_id, jsonb_build_object('to', status) AS payload FROM task WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
  'invoice.issued': `SELECT 'invoice' AS et, id, client_id, '{}'::jsonb AS payload FROM invoice WHERE kind = 'invoice' AND status <> 'draft' AND status <> 'cancelled' ORDER BY issue_date DESC NULLS LAST`,
  'receipt.recorded': `SELECT 'receipt' AS et, id, client_id, '{}'::jsonb AS payload FROM receipt WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  'document.uploaded': `SELECT 'document' AS et, id, client_id, jsonb_build_object('source', source) AS payload FROM document WHERE client_id IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC`,
  'notice.received': `SELECT 'notice' AS et, id, client_id, '{}'::jsonb AS payload FROM notice WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  'lead.stage_changed': `SELECT 'lead' AS et, id, client_id, jsonb_build_object('to', stage) AS payload FROM lead WHERE deleted_at IS NULL ORDER BY stage_changed_at DESC`,
  'proposal.accepted': `SELECT 'proposal' AS et, id, NULL::uuid AS client_id, '{}'::jsonb AS payload FROM proposal WHERE status = 'accepted' ORDER BY decided_at DESC NULLS LAST`,
  'proposal.converted': `SELECT 'proposal' AS et, id, NULLIF(conversion->>'clientId', '')::uuid AS client_id, '{}'::jsonb AS payload FROM proposal WHERE conversion IS NOT NULL ORDER BY converted_at DESC NULLS LAST`,
};
const ENTITY_TABLE: Record<string, string> = { task: 'task', invoice: 'invoice', receipt: 'receipt', document: 'document', notice: 'notice', lead: 'lead', proposal: 'proposal', pbc: 'pbc_item', hearing: 'notice_hearing', dsc: 'dsc', licence: 'licence' };

/**
 * What a rule would have seen: the most recent real outbox events of that type, topped up with synthesised ones from the
 * source tables (a new rule has no outbox history), or exactly one entity. Read-only.
 */
export async function candidateEvents(tx: Tx, type: string, today: string, o: { limit: number; entityType?: string; entityId?: string; ruleId?: string | null }): Promise<EventRow[]> {
  if (type === 'schedule') return [{ id: null, type, entity_type: 'automation_rule', entity_id: o.ruleId ?? '00000000-0000-0000-0000-000000000000', client_id: null, payload: {}, causation: null, occurred_at: null }];
  if (o.entityId) {
    if (isScanEvent(type)) {
      const s = SCANS[type]!;
      const r = (await tx.query(`SELECT '${s.et}'::text AS et, x.id, x.client_id, to_char(${s.due}, 'YYYY-MM-DD') AS due FROM ${s.from} WHERE x.id = $1`, [o.entityId])).rows[0];
      return r ? [{ id: null, type, entity_type: r.et, entity_id: r.id, client_id: r.client_id, payload: r.due ? { due: r.due, subjectKey: subjectKeyOf(r.et, r.id, r.due) } : {}, causation: null, occurred_at: null }] : [];
    }
    const et = o.entityType ?? RECENT[type]?.match(/'(\w+)' AS et/)?.[1] ?? '';
    const table = ENTITY_TABLE[et];
    if (!table) return [];
    const r = (await tx.query(`SELECT id, ${table === 'lead' || table === 'proposal' ? 'NULL::uuid' : 'client_id'} AS client_id FROM ${table} WHERE id = $1`, [o.entityId])).rows[0];
    return r ? [{ id: null, type, entity_type: et, entity_id: r.id, client_id: r.client_id, payload: {}, causation: null, occurred_at: null }] : [];
  }
  const real = (await tx.query(`SELECT * FROM automation_event WHERE type = $1 ORDER BY occurred_at DESC LIMIT $2`, [type, o.limit])).rows as EventRow[];
  if (real.length >= o.limit) return real;
  const seen = new Set(real.map((r) => r.entity_id));
  const more = isScanEvent(type)
    ? (await tx.query(scanSelect(type, '', o.limit), [today, SCAN_WINDOW_DAYS])).rows.map((r) => ({ id: null, type, entity_type: r.et, entity_id: r.id, client_id: r.client_id, payload: { due: r.due, subjectKey: subjectKeyOf(r.et, r.id, r.due) }, causation: null, occurred_at: null }))
    : (await tx.query(`${RECENT[type]} LIMIT ${Number(o.limit)}`)).rows.map((r) => ({ id: null, type, entity_type: r.et, entity_id: r.id, client_id: r.client_id, payload: r.payload, causation: null, occurred_at: null }));
  return [...real, ...more.filter((m) => !seen.has(m.entity_id))].slice(0, o.limit);
}
