import { CATEGORIES, prefsSchema } from '@worko/notify';
import { can } from '@worko/domain';
import { z, type ZodTypeAny } from 'zod';
import type { RequestActor } from '../auth/context.js';

/**
 * Every table that devices sync. Only listed columns ever leave or enter the server; `writable` columns
 * may be patched by clients (zod-validated). Adding a module = adding an entry here + tests.
 */
export type SyncTableDef = {
  /** SQL table name (identifier is trusted: comes from this file, never from input). */
  table: string;
  /** Columns shipped to clients (besides id/version/deleted). */
  columns: string[];
  /** Client-patchable columns with validation. */
  writable: Record<string, ZodTypeAny>;
  /** Money/legal records: reject stale baseVersion instead of merging (spec §8). */
  strict?: boolean;
  /** SQL predicate (params: $1 = actor user id) for rows this actor syncs at all; others are never mentioned. */
  scopeSql: string;
  /** Table-level gate: actors failing it never receive (or write) this table at all. */
  visible?: (a: RequestActor) => boolean;
  /** May the actor create a row with this initial patch? `owner` columns are forced server-side. */
  canInsert?: (a: RequestActor) => boolean;
  /** Columns forced on insert (e.g. user_id = actor). */
  owner?: (a: RequestActor) => Record<string, unknown>;
  canUpdate: (a: RequestActor, row: Record<string, unknown>) => boolean;
  canDelete?: (a: RequestActor, row: Record<string, unknown>) => boolean;
  /** Whether client mutations are audit-logged (read-receipts are not: they'd drown the log). */
  audit: boolean;
};

const iso = z.string().datetime({ offset: true }).nullable();

export const SYNC_TABLES: Record<string, SyncTableDef> = {
  notification: {
    table: 'notification',
    columns: ['user_id', 'category', 'priority', 'title', 'body', 'entity_type', 'entity_id', 'fire_at', 'read_at', 'acked_at',
      'snoozed_until', 'requires_ack', 'escalation_level', 'created_at'],
    writable: { read_at: iso, acked_at: iso, snoozed_until: iso },
    scopeSql: 'user_id = $1',
    canUpdate: (a, row) => row.user_id === a.userId,
    canDelete: (a, row) => row.user_id === a.userId,
    audit: false,
  },
  notification_pref: {
    table: 'notification_pref',
    columns: ['user_id', 'prefs'],
    writable: { prefs: prefsSchema },
    scopeSql: 'user_id = $1',
    canInsert: () => true,
    owner: (a) => ({ user_id: a.userId }),
    canUpdate: (a, row) => row.user_id === a.userId,
    audit: true,
  },
  // Read-only on devices: team lead/membership changes grant access and redirect escalations, so they
  // go only through the REST endpoints, which validate users and branch scope.
  team: {
    table: 'team',
    columns: ['name', 'branch_id', 'lead_user_id'],
    writable: {},
    scopeSql: 'true',
    visible: (a) => can(a, 'users', 'view', { branchId: a.branchId }),
    canUpdate: () => false,
    audit: true,
  },
};

export const SYNC_TABLES_TOKEN = 'SYNC_TABLES';
export { CATEGORIES };
