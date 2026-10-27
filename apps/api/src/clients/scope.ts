import { effectiveScope, type Action, type Actor, type Module } from '@worko/domain';

/** Collects positional parameters while building SQL. */
export class Params {
  readonly values: unknown[];
  constructor(initial: unknown[] = []) { this.values = [...initial]; }
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

/**
 * SQL twin of `can(actor, module, action, clientCtx(row))` over a `client` row aliased `c`.
 * Kept in lock-step with @worko/domain by a property test (test/scope.int.test.ts).
 */
export function clientScopeSql(a: Actor & { superAdmin?: boolean }, module: Module, action: Action, p: Params, c = 'c'): string {
  if (a.superAdmin) return 'TRUE';
  const g = effectiveScope(a, module, action);
  if (!g || g.scope === 'none') return 'FALSE';
  const me = p.add(a.userId);
  const sensitive = `(NOT ${c}.sensitive OR ${me}::uuid = ANY(${c}.allowed_user_ids))`;
  const owner = `(${c}.partner_id = ${me}::uuid OR ${c}.manager_id = ${me}::uuid OR ${me}::uuid = ANY(${c}.staff_ids))`;
  let rule: string;
  switch (g.scope) {
    case 'all': rule = 'TRUE'; break;
    case 'branch': rule = a.branchId ? `(${c}.branch_id IS NULL OR ${c}.branch_id = ${p.add(a.branchId)}::uuid)` : `${c}.branch_id IS NULL`; break;
    case 'groups': rule = `${c}.group_ids && ${p.add(g.clientGroupIds ?? [])}::uuid[]`; break;
    case 'team': rule = `((${c}.team_id IS NOT NULL AND ${c}.team_id = ANY(${p.add(a.teamIds)}::uuid[])) OR ${owner})`; break;
    case 'own': rule = owner; break;
  }
  return `(${rule} AND ${sensitive})`;
}
