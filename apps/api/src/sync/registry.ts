import { can, clientCtx, ENTITY_TYPES, hiddenFieldsOf, isValidPan, isValidTan, type ClientVisibility } from '@worko/domain';
import { prefsSchema } from '@worko/notify';
import { z, type ZodTypeAny } from 'zod';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, type Params } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';

/**
 * Every table that devices sync. Only listed columns ever leave or enter the server; `writable` columns may be
 * patched by clients (zod-validated). Adding a module = adding an entry here + tests.
 */
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
  /** Server-assigned columns on insert (owner, numbering…). Overrides anything the client sent. */
  beforeInsert?: (a: RequestActor, row: Record<string, unknown>, tx: Tx) => Promise<Record<string, unknown>> | Record<string, unknown>;
  canUpdate: (a: RequestActor, row: Record<string, unknown>, tx: Tx) => boolean | Promise<boolean>;
  canDelete?: (a: RequestActor, row: Record<string, unknown>, tx: Tx) => boolean | Promise<boolean>;
  /** Whether client mutations are audit-logged (read-receipts are not: they'd drown the log). */
  audit: boolean;
};

const iso = z.string().datetime({ offset: true }).nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const short = (n = 200) => z.string().trim().max(n).nullable();
const uuid = z.string().uuid();

export const visibilityOf = (r: Record<string, unknown>): ClientVisibility => ({
  branchId: (r.branch_id as string) ?? null, partnerId: (r.partner_id as string) ?? null, managerId: (r.manager_id as string) ?? null,
  teamId: (r.team_id as string) ?? null, staffIds: (r.staff_ids as string[]) ?? [], groupIds: (r.group_ids as string[]) ?? [],
  sensitive: !!r.sensitive, allowedUserIds: (r.allowed_user_ids as string[]) ?? [],
});

/** Loads a client row for permission checks on child records. */
async function parentClient(tx: Tx, clientId: unknown) {
  if (typeof clientId !== 'string') return null;
  return (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0] ?? null;
}
const childOf = (module: 'clients' | 'documents' | 'registers') => ({
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
    beforeInsert: async (a, row, tx) => {
      const fy = fyOf(String(row.received_on ?? new Date().toISOString().slice(0, 10)));
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
    beforeInsert: async (a, row, tx) => {
      const fy = fyOf(String(row.sent_on ?? new Date().toISOString().slice(0, 10)));
      return { fy, number: await nextNumber(tx, a.tenantId, 'OUT', fy), sent_by: a.userId };
    },
    audit: true,
  },
};

/** Child tables whose visibility follows their client (used for revocations). */
export const CLIENT_CHILD_TABLES = ['contact', 'client_registration', 'document', 'inward_entry', 'outward_entry'] as const;

export const SYNC_TABLES_TOKEN = 'SYNC_TABLES';
