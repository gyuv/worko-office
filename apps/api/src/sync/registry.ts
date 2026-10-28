import { can, canOwn, clientCtx, istDate, roundCoord, effectiveScope, ENTITY_TYPES, hiddenFieldsOf, isValidPan, isValidTan, TASK_PRIORITIES, TASK_STATUSES, taskChangeError, type TaskCheck } from '@worko/domain';
import { prefsSchema } from '@worko/notify';
import { z, type ZodTypeAny } from 'zod';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, visibilityOf, type Params } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';
import { checkOutError, checkOutFields, evaluateCheckIn } from '../hr/common.js';
import { RejectError } from './reject.js';
import { calendarEventError, calendarScopeSql, calendarWritable, canDeleteChatMessage, chatMessageAfter, chatMessageDerive, chatMessageError, chatMessageWritable, isMember, memberSql, ownEditable } from '../comm/sync-rules.js';
import { taskForEntry, timeEntryError } from '../time/rules.js';
import { actorChangeError, canTaskRow, checkPeopleAndRevoke, clientOfTask, PEOPLE_COLS, stampChecks, stateOf, taskScopeSql, ymd } from '../tasks/scope.js';

/**
 * Every table that devices sync. Only listed columns ever leave or enter the server; `writable` columns may be
 * patched by clients (zod-validated). Adding a module = adding an entry here + tests.
 */
/** Server context for hooks: the injectable clock's "now" (never the wall clock directly) and the transaction. */
export type HookCtx = { now: Date; tx: Tx };

export type SyncTableDef = {
  /** SQL table name (identifier is trusted: comes from this file, never from input). */
  table: string;
  /** Columns shipped to clients (besides id/version/deleted). */
  columns: string[];
  /** jsonb columns (serialised as JSON); everything else is passed to pg as-is (arrays → SQL arrays). */
  json?: string[];
  /** Client-patchable columns with validation. */
  writable: Record<string, ZodTypeAny>;
  /** Writable on insert only (e.g. the parent client of a contact). */
  immutable?: string[];
  /** Money/legal records: reject stale baseVersion instead of merging (spec §8). */
  strict?: boolean;
  /** Rows this actor syncs, as SQL over alias `x` (use `p.add()` for parameters). */
  scope: (a: RequestActor, p: Params) => string;
  /** Table-level gate: actors failing it never receive (or write) this table at all. */
  visible?: (a: RequestActor) => boolean;
  /** Columns never shipped to this actor (field-level hiding, e.g. fees). */
  hide?: (a: RequestActor) => string[];
  canInsert?: (a: RequestActor, row: Record<string, unknown>, tx: Tx) => boolean | Promise<boolean>;
  /** Columns replaced by '[omitted]' in audit diffs (personal data such as coordinates). */
  auditOmit?: string[];
  /** Server-assigned columns on insert (owner, numbering…). Overrides anything the client sent. */
  beforeInsert?: (a: RequestActor, row: Record<string, unknown>, tx: Tx, ctx: HookCtx) => Promise<Record<string, unknown>> | Record<string, unknown>;
  canUpdate: (a: RequestActor, row: Record<string, unknown>, tx: Tx) => boolean | Promise<boolean>;
  canDelete?: (a: RequestActor, row: Record<string, unknown>, tx: Tx, ctx: HookCtx) => boolean | Promise<boolean>;
  /** Business rules over the row as it would be after the change (cur = null on insert); returns a reject reason. */
  validate?: (a: RequestActor, cur: Record<string, unknown> | null, next: Record<string, unknown>, tx: Tx, ctx: HookCtx) => Promise<string | null> | string | null;
  /** Server-derived columns written alongside a valid change (timestamps, stamps); bypass `writable`. */
  derive?: (a: RequestActor, cur: Record<string, unknown> | null, patch: Record<string, unknown>, ctx: HookCtx) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Side effects after a successful insert/update in the same transaction (e.g. mention notifications); may return a cursor to publish. */
  afterWrite?: (a: RequestActor, cur: Record<string, unknown> | null, row: Record<string, unknown>, ctx: HookCtx) => Promise<number | void> | number | void;
  /** Whether client mutations are audit-logged (read-receipts are not: they'd drown the log). */
  audit: boolean;
};

const iso = z.string().datetime({ offset: true }).nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const short = (n = 200) => z.string().trim().max(n).nullable();
const uuid = z.string().uuid();

export { visibilityOf };

/** Loads a client row for permission checks on child records. */
async function parentClient(tx: Tx, clientId: unknown) {
  if (typeof clientId !== 'string') return null;
  return (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0] ?? null;
}
const childOf = (module: 'clients' | 'documents' | 'registers' | 'tasks') => ({
  scope: (a: RequestActor, p: Params) => `EXISTS (SELECT 1 FROM client c WHERE c.id = x.client_id AND ${clientScopeSql(a, 'clients', 'view', p)}${module === 'clients' ? '' : ` AND ${clientScopeSql(a, module, 'view', p)}`})`,
  canInsert: async (a: RequestActor, row: Record<string, unknown>, tx: Tx) => {
    const c = await parentClient(tx, row.client_id);
    return !!c && can(a, module === 'clients' ? 'clients' : module, module === 'clients' ? 'edit' : 'create', clientCtx(visibilityOf(c)));
  },
  canUpdate: async (a: RequestActor, row: Record<string, unknown>, tx: Tx) => {
    const c = await parentClient(tx, row.client_id);
    return !!c && can(a, module, 'edit', clientCtx(visibilityOf(c)));
  },
  canDelete: async (a: RequestActor, row: Record<string, unknown>, tx: Tx) => {
    const c = await parentClient(tx, row.client_id);
    return !!c && can(a, module, module === 'clients' ? 'edit' : 'delete', clientCtx(visibilityOf(c)));
  },
});

/** Next number in a per-FY register series, e.g. IN/2026-27/0007. */
export async function nextNumber(tx: Tx, tenantId: string, kind: 'IN' | 'OUT', fy: string): Promise<string> {
  const r = await tx.query(
    `INSERT INTO register_counter (tenant_id, kind, fy, next) VALUES ($1,$2,$3,2)
     ON CONFLICT (tenant_id, kind, fy) DO UPDATE SET next = register_counter.next + 1 RETURNING next - 1 AS n`, [tenantId, kind, fy]);
  return `${kind}/${fy}/${String(r.rows[0].n).padStart(4, '0')}`;
}
export function fyOf(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}

export const checkSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(200), required: z.boolean().default(false),
  done: z.boolean().default(false), doneBy: z.string().uuid().nullable().optional(), doneAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export const taskWritable = {
  client_id: uuid.nullable(), service_type_id: uuid.nullable(), period_key: short(30), title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).nullable(), status: z.enum(TASK_STATUSES), priority: z.enum(TASK_PRIORITIES),
  statutory_due: date, act_by: date, leader_id: uuid.nullable(), manager_id: uuid.nullable(), assignee_id: uuid.nullable(), reviewer_id: uuid.nullable(),
  checks: z.array(checkSchema).max(50), pending_issue: z.string().max(2000).nullable(),
  estimate_minutes: z.number().int().min(0).max(100_000).nullable(),
};

const items = z.array(z.object({ description: z.string().max(300), qty: z.number().int().min(1).max(10_000).default(1), original: z.boolean().default(false) })).max(100);

export const SYNC_TABLES: Record<string, SyncTableDef> = {
  notification: {
    table: 'notification',
    columns: ['user_id', 'category', 'priority', 'title', 'body', 'entity_type', 'entity_id', 'fire_at', 'read_at', 'acked_at',
      'snoozed_until', 'requires_ack', 'escalation_level', 'created_at'],
    writable: { read_at: iso, acked_at: iso, snoozed_until: iso },
    scope: (a, p) => `x.user_id = ${p.add(a.userId)}::uuid`,
    canUpdate: (a, row) => row.user_id === a.userId,
    canDelete: (a, row) => row.user_id === a.userId,
    audit: false,
  },
  notification_pref: {
    table: 'notification_pref',
    columns: ['user_id', 'prefs'], json: ['prefs'],
    writable: { prefs: prefsSchema },
    scope: (a, p) => `x.user_id = ${p.add(a.userId)}::uuid`,
    canInsert: () => true,
    beforeInsert: (a) => ({ user_id: a.userId }),
    canUpdate: (a, row) => row.user_id === a.userId,
    audit: true,
  },
  // Read-only on devices: team lead/membership changes grant access and redirect escalations, so they
  // go only through the REST endpoints, which validate users and branch scope.
  team: {
    table: 'team',
    columns: ['name', 'branch_id', 'lead_user_id'],
    writable: {},
    scope: () => 'TRUE',
    visible: (a) => can(a, 'users', 'view', { branchId: a.branchId }),
    canUpdate: () => false,
    audit: true,
  },
  client_group: {
    table: 'client_group',
    columns: ['name', 'kind', 'parent_id', 'notes'],
    writable: {},
    scope: () => 'TRUE',
    visible: (a) => !!a.roles.length,
    canUpdate: () => false,
    audit: true,
  },
  custom_field_def: {
    table: 'custom_field_def',
    columns: ['entity', 'key', 'label', 'type', 'options', 'required', 'sort'], json: ['options'],
    writable: {},
    scope: () => 'TRUE',
    visible: (a) => !!a.roles.length,
    canUpdate: () => false,
    audit: true,
  },
  client: {
    table: 'client',
    columns: ['file_no', 'name', 'trade_name', 'entity_type', 'pan', 'tan', 'cin', 'udyam', 'iec', 'aadhaar_last4', 'bank_accounts_masked',
      'dob', 'email', 'phone', 'addresses', 'source', 'status', 'tags', 'custom', 'notes', 'compliance_profile',
      'branch_id', 'partner_id', 'manager_id', 'team_id', 'staff_ids', 'group_ids', 'sensitive', 'created_at'],
    json: ['bank_accounts_masked', 'addresses', 'custom', 'compliance_profile'],
    // Visibility columns are deliberately absent: they change only via REST, which records revocations.
    writable: {
      name: z.string().trim().min(1).max(300), trade_name: short(300), file_no: short(50),
      entity_type: z.enum(ENTITY_TYPES), pan: z.string().trim().toUpperCase().refine(isValidPan, 'Invalid PAN').nullable(),
      tan: z.string().trim().toUpperCase().refine(isValidTan, 'Invalid TAN').nullable(), cin: short(30), udyam: short(30), iec: short(20),
      dob: date, email: z.string().trim().email().max(200).nullable(), phone: z.string().regex(/^\+?\d{10,15}$/).nullable(),
      addresses: z.array(z.object({ kind: z.string().max(30), line1: z.string().max(200), line2: z.string().max(200).optional(), city: z.string().max(100), state: z.string().max(100), pin: z.string().regex(/^\d{6}$/) })).max(10),
      status: z.enum(['active', 'inactive', 'prospect']), tags: z.array(z.string().max(50)).max(30), custom: z.record(z.unknown()), notes: z.string().max(5000).nullable(),
    },
    scope: (a, p) => clientScopeSql(a, 'clients', 'view', p, 'x'),
    hide: (a) => hiddenFieldsOf(a).filter((f) => f.startsWith('client.')).map((f) => f.slice(7)),
    canInsert: (a) => can(a, 'clients', 'create', { branchId: a.branchId, ownerUserIds: [a.userId] }),
    // Creator stays able to see what they created even with 'own' scope.
    beforeInsert: (a) => ({ branch_id: a.branchId, staff_ids: [a.userId] }),
    canUpdate: (a, row) => can(a, 'clients', 'edit', clientCtx(visibilityOf(row))),
    audit: true,
  },
  contact: {
    table: 'contact',
    columns: ['client_id', 'name', 'role', 'email', 'phone', 'whatsapp', 'dob', 'anniversary', 'is_primary', 'notes'],
    writable: { client_id: uuid, name: z.string().trim().min(1).max(200), role: short(100), email: z.string().trim().email().max(200).nullable(), phone: z.string().regex(/^\+?\d{10,15}$/).nullable(),
      whatsapp: z.string().regex(/^\+?\d{10,15}$/).nullable(), dob: date, anniversary: date, is_primary: z.boolean(), notes: z.string().max(2000).nullable() },
    immutable: ['client_id'],
    ...childOf('clients'),
    audit: true,
  },
  client_registration: {
    table: 'client_registration',
    columns: ['client_id', 'kind', 'number', 'state_code', 'status', 'registered_on', 'is_primary', 'meta'], json: ['meta'],
    writable: { client_id: uuid, kind: z.enum(['GSTIN', 'TAN', 'CIN', 'LLPIN', 'DIN', 'UDYAM', 'IEC', 'PF', 'ESI', 'PT', 'FSSAI', 'SHOPS', 'OTHER']),
      number: z.string().trim().toUpperCase().min(1).max(50), state_code: z.string().regex(/^\d{2}$/).nullable(), status: short(50), registered_on: date, is_primary: z.boolean(), meta: z.record(z.unknown()) },
    immutable: ['client_id', 'kind'],
    ...childOf('clients'),
    audit: true,
  },
  document: {
    table: 'document',
    // Metadata only: file bytes are fetched on demand through signed download URLs.
    columns: ['client_id', 'fy', 'category', 'name', 'mime', 'size', 'current_version', 'tags', 'permanent', 'expires_on', 'legal_hold', 'uploaded_by', 'created_at'],
    writable: { name: z.string().trim().min(1).max(300), category: z.string().trim().min(1).max(100), fy: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
      tags: z.array(z.string().max(50)).max(30), permanent: z.boolean(), expires_on: date },
    ...childOf('documents'),
    canInsert: () => false, // bytes must go through the upload endpoint
    audit: true,
  },
  inward_entry: {
    table: 'inward_entry',
    columns: ['number', 'fy', 'client_id', 'received_on', 'mode', 'from_name', 'from_phone', 'description', 'items', 'returnable', 'due_back', 'returned_on', 'signature_doc_id', 'received_by'],
    json: ['items'],
    writable: { client_id: uuid, received_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mode: z.enum(['physical', 'email', 'whatsapp', 'courier', 'portal', 'other']),
      from_name: short(200), from_phone: z.string().regex(/^\+?\d{10,15}$/).nullable(), description: z.string().trim().min(1).max(1000), items,
      returnable: z.boolean(), due_back: date, returned_on: date },
    immutable: ['client_id', 'received_on'], // number + FY derive from the date (D51)
    ...childOf('registers'),
    beforeInsert: async (a, row, tx, ctx) => {
      const fy = fyOf(String(row.received_on ?? istDate(ctx.now)));
      return { fy, number: await nextNumber(tx, a.tenantId, 'IN', fy), received_by: a.userId };
    },
    audit: true,
  },
  outward_entry: {
    table: 'outward_entry',
    columns: ['number', 'fy', 'client_id', 'sent_on', 'mode', 'to_name', 'to_phone', 'courier_name', 'tracking_no', 'description', 'items', 'original', 'to_be_received_back', 'received_back_on', 'signature_doc_id', 'sent_by'],
    json: ['items'],
    writable: { client_id: uuid, sent_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mode: z.enum(['hand', 'courier', 'email', 'whatsapp', 'post', 'other']),
      to_name: short(200), to_phone: z.string().regex(/^\+?\d{10,15}$/).nullable(), courier_name: short(100), tracking_no: short(100),
      description: z.string().trim().min(1).max(1000), items, original: z.boolean(), to_be_received_back: z.boolean(), received_back_on: date },
    immutable: ['client_id', 'sent_on'], // number + FY derive from the date (D51)
    ...childOf('registers'),
    beforeInsert: async (a, row, tx, ctx) => {
      const fy = fyOf(String(row.sent_on ?? istDate(ctx.now)));
      return { fy, number: await nextNumber(tx, a.tenantId, 'OUT', fy), sent_by: a.userId };
    },
    audit: true,
  },
  // Firm-wide catalogue: read-only on devices (edited via REST with settings:edit).
  service_type: {
    table: 'service_type',
    columns: ['key', 'name', 'category', 'description', 'frequency', 'rule_id', 'sla_days', 'default_checks', 'leader_id', 'manager_id', 'reviewer_id', 'assignee_id', 'billable', 'active'],
    json: ['default_checks'],
    writable: {},
    scope: () => 'TRUE',
    visible: (a) => !!a.superAdmin || (effectiveScope(a, 'tasks', 'view')?.scope ?? 'none') !== 'none',
    canUpdate: () => false,
    audit: true,
  },
  client_service: {
    table: 'client_service',
    columns: ['client_id', 'service_type_id', 'start_period', 'end_period', 'leader_id', 'manager_id', 'reviewer_id', 'assignee_id', 'active', 'notes'],
    writable: {},
    ...childOf('tasks'),
    canInsert: () => false, // subscriptions change via REST (validated people + periods)
    canUpdate: () => false,
    canDelete: () => false,
    audit: true,
  },
  task: {
    table: 'task',
    columns: ['client_id', 'service_type_id', 'period_key', 'period_label', 'title', 'description', 'status', 'priority', 'statutory_due', 'act_by',
      'leader_id', 'manager_id', 'assignee_id', 'reviewer_id', 'checks', 'pending_issue', 'outcome', 'closed_at', 'completed_at', 'source', 'rule_id',
      'extension_id', 'created_by', 'created_at', 'estimate_minutes'],
    json: ['checks'],
    writable: taskWritable,
    immutable: ['client_id', 'service_type_id', 'period_key'],
    // clients:view on the client AND tasks:view on the task (its people count as owners) — D52 + D55.
    scope: (a, p) => `EXISTS (SELECT 1 FROM (SELECT 1) _v LEFT JOIN client c ON c.id = x.client_id WHERE ${taskScopeSql(a, 'view', p, 'x', 'c')})`,
    visible: (a) => !!a.superAdmin || (effectiveScope(a, 'tasks', 'view')?.scope ?? 'none') !== 'none',
    canInsert: async (a, row, tx) => {
      const c = await clientOfTask(tx, row.client_id);
      if (row.client_id && !c) return false;
      return canTaskRow(a, 'create', row, tx, c);
    },
    beforeInsert: (a) => ({ source: 'manual', created_by: a.userId, outcome: null }),
    canUpdate: (a, row, tx) => canTaskRow(a, 'edit', row, tx),
    canDelete: () => false, // tasks end via close (billed/free/deleted), never a bare delete
    validate: async (a, cur, next, tx) => {
      // Changing who works on a task is 'assign' (an assignee may move status/checks, not hand the task on).
      if (cur) {
        const who = await actorChangeError(a, cur, next, tx);
        if (who) return who;
      } else if (PEOPLE_COLS.some((f) => !!next[f] && next[f] !== a.userId) && !(await canTaskRow(a, 'assign', next, tx))) return 'forbidden';
      const why = taskChangeError(cur ? stateOf(cur) : null, stateOf(next));
      if (why) return why;
      if (!next.title && !cur) return 'invalid:title';
      return checkPeopleAndRevoke(tx, a.tenantId, cur, next);
    },
    derive: (a, cur, patch, ctx) => {
      const out: Record<string, unknown> = {};
      if ('checks' in patch) out.checks = stampChecks((cur?.checks as TaskCheck[]) ?? [], patch.checks as TaskCheck[], a.userId, ctx.now.toISOString());
      if ('status' in patch && patch.status !== cur?.status) out.completed_at = patch.status === 'done' ? ctx.now.toISOString() : null;
      return out;
    },
    audit: true,
  },
  // Billing (D72): headers only, read-only on devices, client-scoped (clients:view AND billing/receipts:view). Money records are
  // strict; every change is server-side (REST) and reaches devices through serverPatch. Lines/allocations stay server-side.
  invoice: {
    table: 'invoice',
    columns: ['kind', 'against_invoice_id', 'entity_id', 'client_id', 'status', 'number', 'fy', 'issue_date', 'due_date', 'supply_type', 'supplier_state', 'place_of_supply',
      'supplier_gstin', 'client_gstin', 'bill_to', 'taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'reimbursement_paise', 'round_off_paise', 'total_paise',
      'allocated_paise', 'tds_paise', 'credited_paise', 'balance_paise', 'source', 'period_key', 'notes', 'reason', 'promise_to_pay', 'followup_paused', 'issued_at', 'cancelled_at', 'cancel_reason'],
    json: ['bill_to'],
    writable: {},
    strict: true,
    scope: (a, p) => `EXISTS (SELECT 1 FROM client c WHERE c.id = x.client_id AND ${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'billing', 'view', p)})`,
    visible: (a) => !!a.superAdmin || ((effectiveScope(a, 'billing', 'view')?.scope ?? 'none') !== 'none' && !hiddenFieldsOf(a).includes('invoice.*')),
    canInsert: () => false,
    canUpdate: () => false,
    canDelete: () => false,
    audit: true,
  },
  receipt: {
    table: 'receipt',
    columns: ['entity_id', 'client_id', 'number', 'fy', 'received_on', 'amount_paise', 'tds_paise', 'tds_section', 'mode', 'reference', 'allocated_paise', 'unallocated_paise', 'source', 'created_at'],
    writable: {},
    strict: true,
    scope: (a, p) => `EXISTS (SELECT 1 FROM client c WHERE c.id = x.client_id AND ${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'receipts', 'view', p)})`,
    visible: (a) => !!a.superAdmin || ((effectiveScope(a, 'receipts', 'view')?.scope ?? 'none') !== 'none' && !hiddenFieldsOf(a).includes('invoice.*')),
    canInsert: () => false,
    canUpdate: () => false,
    canDelete: () => false,
    audit: true,
  },
  // Personal to-dos: only ever synced to (and written by) their owner.
  todo: {
    table: 'todo',
    columns: ['owner_id', 'title', 'notes', 'due_at', 'done', 'done_at', 'task_id', 'sort', 'created_at'],
    writable: { title: z.string().trim().min(1).max(300), notes: z.string().max(2000).nullable(), due_at: iso, done: z.boolean(), done_at: iso,
      task_id: uuid.nullable(), sort: z.number().int().min(-1_000_000).max(1_000_000) },
    scope: (a, p) => `x.owner_id = ${p.add(a.userId)}::uuid`,
    visible: (a) => !!a.roles.length || !!a.superAdmin,
    canInsert: () => true,
    beforeInsert: (a) => ({ owner_id: a.userId }),
    canUpdate: (a, row) => row.owner_id === a.userId,
    canDelete: (a, row) => row.owner_id === a.userId,
    validate: async (a, cur, next, tx) => {
      // A to-do may point at a task only if the owner can see that task (checked when it is set/changed).
      if (!next.task_id || next.task_id === cur?.task_id) return null;
      const t = (await tx.query('SELECT * FROM task WHERE id = $1 AND deleted_at IS NULL', [next.task_id])).rows[0];
      return t && (await canTaskRow(a, 'view', t, tx)) ? null : 'invalid:task_id';
    },
    audit: false,
  },

  // ---------- Phase 6 (D89): personal rows sync only to their owner; firm calendars to everyone with a role ----------
  time_entry: {
    table: 'time_entry',
    columns: ['user_id', 'task_id', 'client_id', 'work_date', 'minutes', 'billable', 'notes', 'source', 'status', 'started_at', 'ended_at', 'capped',
      'reverses_id', 'submitted_at', 'decided_by', 'decided_at', 'decision_note', 'created_at'],
    writable: { task_id: uuid.nullable(), client_id: uuid.nullable(), work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), minutes: z.number().int().min(1).max(1440),
      billable: z.boolean(), notes: z.string().max(2000).nullable(), status: z.enum(['draft', 'submitted']) },
    scope: (a, p) => `x.user_id = ${p.add(a.userId)}::uuid`,
    visible: (a) => canOwn(a, 'time'),
    canInsert: (a) => canOwn(a, 'time'),
    beforeInsert: async (a, row, tx) => {
      const t = row.task_id ? await taskForEntry(a, tx, row.task_id) : undefined;
      return { user_id: a.userId, source: 'manual', status: row.status ?? 'draft', ...(t && row.client_id === undefined ? { client_id: t.client_id ?? null } : {}) };
    },
    canUpdate: (a, row) => row.user_id === a.userId && row.status !== 'approved',
    canDelete: (a, row) => row.user_id === a.userId && ['draft', 'rejected'].includes(String(row.status)),
    // Same rules as REST, including "no future dates" against the injectable clock (IST).
    validate: (a, cur, next, tx, ctx) => (next.work_date && (ymd(next.work_date) ?? '') > istDate(ctx.now) && (!cur || ymd(next.work_date) !== ymd(cur.work_date)) ? 'future_date' : timeEntryError(a, cur, next, tx)),
    derive: (_a, cur, patch, ctx) => ('status' in patch && patch.status !== cur?.status ? { submitted_at: patch.status === 'submitted' ? ctx.now.toISOString() : null } : {}),
    audit: true,
  },
  // Read-only on devices: timers start/stop through REST so the server clock is authoritative.
  time_timer: {
    table: 'time_timer',
    columns: ['user_id', 'task_id', 'client_id', 'notes', 'billable', 'started_at', 'device_started_at', 'stopped_at', 'entry_id'],
    writable: {},
    scope: (a, p) => `x.user_id = ${p.add(a.userId)}::uuid`,
    visible: (a) => canOwn(a, 'time'),
    canInsert: () => false, canUpdate: () => false, canDelete: () => false,
    audit: true,
  },
  // Devices may check in (insert) and check out (update) offline; the server stamps its own times, fence, IP and skew.
  attendance: {
    table: 'attendance',
    columns: ['user_id', 'work_date', 'check_in_at', 'check_out_at', 'device_check_in_at', 'device_check_out_at', 'received_at', 'in_lat', 'in_lng', 'out_lat', 'out_lng',
      'location_id', 'distance_m', 'in_fence', 'ip_ok', 'method', 'flags', 'status', 'minutes', 'notes'],
    writable: { device_check_in_at: iso, in_lat: z.number().min(-90).max(90).nullable(), in_lng: z.number().min(-180).max(180).nullable(),
      device_check_out_at: iso, out_lat: z.number().min(-90).max(90).nullable(), out_lng: z.number().min(-180).max(180).nullable(), notes: z.string().max(500).nullable() },
    immutable: ['device_check_in_at', 'in_lat', 'in_lng'],
    // Coordinates never reach the audit log (D88/D95).
    auditOmit: ['in_lat', 'in_lng', 'out_lat', 'out_lng'],
    scope: (a, p) => `x.user_id = ${p.add(a.userId)}::uuid`,
    visible: (a) => canOwn(a, 'hr'),
    canInsert: (a) => canOwn(a, 'hr'),
    // Offline check-in: the device time decides the day/time, bounded (not future, ≤ offlineMaxDays old); receipt time kept (D95).
    beforeInsert: async (a, row, tx, ctx) => {
      const ev = await evaluateCheckIn(tx, { lat: row.in_lat as number | null, lng: row.in_lng as number | null, deviceAt: row.device_check_in_at ? new Date(String(row.device_check_in_at)) : null,
        ip: null, serverAt: ctx.now, branchId: a.branchId, method: 'offline' });
      if ('reject' in ev) throw new RejectError(ev.reject);
      return { ...ev, user_id: a.userId, device_check_out_at: null, out_lat: null, out_lng: null };
    },
    canUpdate: (a, row) => row.user_id === a.userId && !row.check_out_at,
    validate: async (_a, cur, next, tx, ctx) => {
      if (!cur) return null;
      if (next.device_check_out_at == null) return next.out_lat != null || next.out_lng != null ? 'invalid:device_check_out_at' : null;
      return checkOutError(tx, cur, new Date(String(next.device_check_out_at)), ctx.now);
    },
    derive: async (_a, cur, patch, ctx) => {
      if (!cur || !('device_check_out_at' in patch) || !patch.device_check_out_at) return {};
      const out = await checkOutFields(ctx.tx, cur, new Date(String(patch.device_check_out_at)), ctx.now);
      const lat = typeof patch.out_lat === 'number' ? roundCoord(patch.out_lat) : null;
      const lng = typeof patch.out_lng === 'number' ? roundCoord(patch.out_lng) : null;
      return { ...out, out_lat: lat, out_lng: lng };
    },
    audit: true,
  },
  holiday: {
    table: 'holiday',
    columns: ['on_date', 'name', 'branch_id', 'optional'],
    writable: {},
    scope: (a, p) => `(x.branch_id IS NULL OR x.branch_id IS NOT DISTINCT FROM ${p.add(a.branchId)}::uuid)`,
    visible: (a) => !!a.roles.length || !!a.superAdmin,
    canUpdate: () => false,
    audit: true,
  },
  leave_type: {
    table: 'leave_type',
    columns: ['key', 'name', 'paid', 'tracked', 'applies_to_roles', 'accrual', 'carry_forward_cap', 'allow_half_day', 'max_days_per_request', 'comp_off', 'active', 'sort', 'notes'],
    json: ['accrual'],
    writable: {},
    scope: () => 'TRUE',
    visible: (a) => !!a.roles.length || !!a.superAdmin,
    canUpdate: () => false,
    audit: true,
  },
  leave_request: {
    table: 'leave_request',
    columns: ['user_id', 'leave_type_id', 'from_date', 'to_date', 'start_half', 'end_half', 'days', 'reason', 'status', 'approved_from', 'approved_to',
      'approved_start_half', 'approved_end_half', 'approved_days', 'decided_by', 'decided_at', 'decision_note', 'cancelled_at', 'created_at'],
    writable: {},
    scope: (a, p) => `x.user_id = ${p.add(a.userId)}::uuid`,
    visible: (a) => canOwn(a, 'hr'),
    canUpdate: () => false,
    audit: true,
  },
  leave_ledger: {
    table: 'leave_ledger',
    columns: ['user_id', 'leave_type_id', 'delta', 'reason', 'ref_key', 'request_id', 'on_date', 'expires_on', 'note', 'created_at'],
    writable: {},
    scope: (a, p) => `x.user_id = ${p.add(a.userId)}::uuid`,
    visible: (a) => canOwn(a, 'hr'),
    canUpdate: () => false,
    audit: false,
  },
  // ---------- Phase 7 (D106): team chat to members only; calendar events own + attended (client-linked only while visible) ----------
  // Channels and membership change via REST (kind-specific membership rules, client visibility of every member).
  chat_channel: {
    table: 'chat_channel',
    columns: ['kind', 'name', 'team_id', 'branch_id', 'client_id', 'archived', 'created_by', 'created_at'],
    writable: {},
    scope: (a, p) => memberSql(a, p, 'x.id'),
    visible: (a) => !!a.roles.length || !!a.superAdmin,
    canUpdate: () => false,
    audit: true,
  },
  // Members see who else is in their channels; each user writes only their own read cursor / mute.
  chat_member: {
    table: 'chat_member',
    columns: ['channel_id', 'user_id', 'role', 'last_read_message_id', 'last_read_at', 'muted', 'joined_at'],
    writable: { last_read_message_id: uuid.nullable(), last_read_at: iso, muted: z.boolean() },
    scope: (a, p) => memberSql(a, p, 'x.channel_id'),
    visible: (a) => !!a.roles.length || !!a.superAdmin,
    canUpdate: async (a, row, tx) => row.user_id === a.userId && !row.deleted_at && (await isMember(tx, a, row.channel_id)),
    validate: async (_a, cur, next, tx) => {
      if (!next.last_read_message_id || next.last_read_message_id === cur?.last_read_message_id) return null;
      return (await tx.query('SELECT 1 FROM chat_message WHERE id = $1 AND channel_id = $2', [next.last_read_message_id, next.channel_id])).rowCount ? null : 'invalid:last_read_message_id';
    },
    audit: false, // read receipts would drown the log
  },
  chat_message: {
    table: 'chat_message',
    columns: ['channel_id', 'author_id', 'body', 'mentions', 'attachment_doc_ids', 'edited_at', 'created_at'],
    writable: chatMessageWritable,
    immutable: ['channel_id'],
    // Bodies never go into audit diffs (D104).
    auditOmit: ['body'],
    scope: (a, p) => memberSql(a, p, 'x.channel_id'),
    visible: (a) => !!a.roles.length || !!a.superAdmin,
    canInsert: (a, row, tx) => isMember(tx, a, row.channel_id),
    beforeInsert: (a, _row, _tx, ctx) => ({ author_id: a.userId, created_at: ctx.now.toISOString(), edited_at: null }),
    canUpdate: async (a, row, tx) => row.author_id === a.userId && !row.deleted_at && (await isMember(tx, a, row.channel_id)),
    canDelete: async (a, row, tx, ctx) => (await canDeleteChatMessage(a, row, tx, ctx)) && (await isMember(tx, a, row.channel_id)),
    validate: (a, cur, next, tx, ctx) => chatMessageError(a, cur, next, tx, ctx),
    derive: (a, cur, patch, ctx) => chatMessageDerive(a, cur, { channel_id: cur?.channel_id, ...patch }, ctx),
    afterWrite: (a, cur, row, ctx) => chatMessageAfter(a, cur, row, ctx),
    audit: true,
  },
  // Devices create/edit their own meetings and personal events; appointment and external (synced-in) events are read-only.
  calendar_event: {
    table: 'calendar_event',
    columns: ['owner_id', 'kind', 'title', 'description', 'location', 'starts_at', 'ends_at', 'all_day', 'client_id', 'attendee_ids', 'accepted_ids', 'appointment_id', 'busy', 'created_at'],
    writable: calendarWritable,
    scope: (a, p) => calendarScopeSql(a, p),
    visible: (a) => !!a.roles.length || !!a.superAdmin,
    canInsert: (a) => !!a.roles.length || !!a.superAdmin,
    beforeInsert: (a, row, _tx, ctx) => ({ owner_id: a.userId, kind: row.kind ?? 'meeting', created_by: a.userId, created_at: ctx.now.toISOString() }),
    canUpdate: (a, row) => ownEditable(a, row),
    canDelete: (a, row) => ownEditable(a, row),
    validate: (a, cur, next, tx) => calendarEventError(a, cur, next, tx),
    // Attendees are invited until they accept (REST respond); removed attendees lose their acceptance.
    derive: (_a, cur, patch) => ('attendee_ids' in patch ? { accepted_ids: ((cur?.accepted_ids as string[]) ?? []).filter((u) => (patch.attendee_ids as string[]).includes(u)) } : {}),
    audit: true,
  },
};

/** Child tables whose visibility follows their client (used for revocations). */
export const CLIENT_CHILD_TABLES = ['contact', 'client_registration', 'document', 'inward_entry', 'outward_entry', 'client_service', 'task', 'invoice', 'receipt'] as const;

export const SYNC_TABLES_TOKEN = 'SYNC_TABLES';
