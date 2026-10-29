import { can, clientCtx, effectiveScope, type Action } from '@worko/domain';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, visibilityOf, type Params } from '../clients/scope.js';

/** Firm-wide dsc scope (staff-held DSCs are firm records). */
export const firmAll = (a: RequestActor, action: Action) => !!a.superAdmin || effectiveScope(a, 'dsc', action)?.scope === 'all';

/** Visibility of a client-held DSC for a SQL scope over alias x (sync registry). */
export function dscScopeSql(a: RequestActor, p: Params) {
  const firm = firmAll(a, 'view') ? 'TRUE' : `(x.holder_user_id = ${p.add(a.userId)}::uuid OR x.custody_user_id = $${p.values.length}::uuid)`;
  return `(CASE WHEN x.client_id IS NULL THEN ${firm} ELSE EXISTS (SELECT 1 FROM client c WHERE c.id = x.client_id AND c.deleted_at IS NULL AND ${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'dsc', 'view', p)}) END)`;
}
export const canSeeClientDsc = (a: RequestActor, c: Record<string, unknown>) => can(a, 'clients', 'view', clientCtx(visibilityOf(c))) && can(a, 'dsc', 'view', clientCtx(visibilityOf(c)));
