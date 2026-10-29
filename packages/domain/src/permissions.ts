import { z } from 'zod';

export const MODULES = [
  'clients', 'leads', 'tasks', 'compliance', 'notices', 'audit', 'billing', 'receipts', 'time',
  'hr', 'documents', 'registers', 'dsc', 'vault', 'communication', 'automation', 'ai', 'reports',
  'settings', 'users', 'audit_log',
] as const;
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'print', 'assign', 'reveal'] as const;
export const SCOPES = ['none', 'own', 'team', 'branch', 'groups', 'all'] as const;

export type Module = (typeof MODULES)[number];
export type Action = (typeof ACTIONS)[number];
export type Scope = (typeof SCOPES)[number];

const SCOPE_RANK: Record<Scope, number> = { none: 0, own: 1, team: 2, groups: 3, branch: 4, all: 5 };

export type Grant = { module: Module; action: Action; scope: Scope; clientGroupIds?: string[] };
export type Role = { key: string; name: string; system: boolean; grants: Grant[]; hiddenFields?: string[] };

export const grantSchema = z.object({
  module: z.enum(MODULES), action: z.enum(ACTIONS), scope: z.enum(SCOPES),
  clientGroupIds: z.array(z.string().uuid()).optional(),
});

/** Resource context used to resolve a scope check. */
export type ResourceCtx = {
  ownerUserIds?: string[];
  teamId?: string | null;
  branchId?: string | null;
  clientGroupIds?: string[];
  sensitive?: boolean;
  allowedUserIds?: string[];
  /** Firm-level record (no client): branch scope does not reach it; only 'all' scope or owners do. */
  firmWide?: boolean;
};
export type Actor = { userId: string; teamIds: string[]; branchId: string | null; roles: Role[]; superAdmin?: boolean };

export function effectiveScope(actor: Actor, module: Module, action: Action): Grant | undefined {
  let best: Grant | undefined;
  for (const r of actor.roles) for (const g of r.grants) {
    if (g.module === module && g.action === action && (!best || SCOPE_RANK[g.scope] > SCOPE_RANK[best.scope])) best = g;
  }
  return best;
}

export function can(actor: Actor, module: Module, action: Action, res: ResourceCtx = {}): boolean {
  if (actor.superAdmin) return true;
  // Sensitive clients are restricted to named users regardless of role scope.
  if (res.sensitive && !(res.allowedUserIds ?? []).includes(actor.userId)) return false;
  const g = effectiveScope(actor, module, action);
  if (!g || g.scope === 'none') return false;
  switch (g.scope) {
    case 'all': return true;
    case 'branch': return !res.firmWide && (!res.branchId || res.branchId === actor.branchId);
    case 'groups': return (res.clientGroupIds ?? []).some((id) => g.clientGroupIds?.includes(id));
    case 'team': return (!!res.teamId && actor.teamIds.includes(res.teamId)) || (res.ownerUserIds ?? []).includes(actor.userId);
    case 'own': return (res.ownerUserIds ?? []).includes(actor.userId);
  }
}

/** True if the actor already holds `g` at the same or a wider scope — used to block privilege escalation. */
export function covers(actor: Actor, g: Grant): boolean {
  if (actor.superAdmin || g.scope === 'none') return true;
  const mine = effectiveScope(actor, g.module, g.action);
  if (!mine || SCOPE_RANK[mine.scope] < SCOPE_RANK[g.scope]) return false;
  // Same rank 'groups': the granted groups must be a subset of the actor's own.
  if (g.scope === 'groups' && mine.scope === 'groups') return (g.clientGroupIds ?? []).every((id) => mine.clientGroupIds?.includes(id));
  return true;
}

/** Fields hidden from the actor: hidden only if every one of their roles hides it. */
export function hiddenFieldsOf(actor: Actor): string[] {
  if (actor.superAdmin || actor.roles.length === 0) return [];
  const [first, ...rest] = actor.roles.map((r) => new Set(r.hiddenFields ?? []));
  return [...first!].filter((f) => rest.every((s) => s.has(f)));
}

/**
 * The actor may assign `role` (or act on a holder of it) only if they hold every grant at equal-or-wider
 * scope AND the role hides at least the fields hidden from the actor.
 */
export function coversRole(actor: Actor, role: Pick<Role, 'grants' | 'hiddenFields'>): boolean {
  if (actor.superAdmin) return true;
  const hidden = new Set(role.hiddenFields ?? []);
  return role.grants.every((g) => covers(actor, g)) && hiddenFieldsOf(actor).every((f) => hidden.has(f));
}

const all = (scope: Scope, actions: readonly Action[] = ACTIONS, mods: readonly Module[] = MODULES): Grant[] =>
  mods.flatMap((module) => actions.map((action) => ({ module, action, scope })));

/** Default system roles; firms may clone and edit. */
export const SYSTEM_ROLES: Role[] = [
  { key: 'partner', name: 'Partner', system: true, grants: all('all') },
  {
    key: 'manager', name: 'Manager', system: true, hiddenFields: [],
    grants: all('team', ['view', 'create', 'edit', 'assign', 'approve', 'export', 'print'],
      MODULES.filter((m) => !['settings', 'users', 'audit_log', 'vault'].includes(m))),
  },
  {
    key: 'senior', name: 'Senior', system: true, hiddenFields: ['client.fees'],
    grants: all('own', ['view', 'create', 'edit', 'print'], ['clients', 'tasks', 'compliance', 'documents', 'registers', 'time', 'hr', 'notices', 'audit', 'communication', 'dsc']),
  },
  {
    key: 'article', name: 'Article / Intern', system: true, hiddenFields: ['client.fees', 'invoice.*'],
    grants: [
      ...all('own', ['view', 'edit'], ['tasks', 'time', 'hr']),
      // Recording inward/outward papers and filing scans is everyday article work — on their own clients only.
      ...all('own', ['view', 'edit', 'create', 'print'], ['documents', 'registers']),
      ...all('own', ['view'], ['clients']),
    ],
  },
  { key: 'accountant', name: 'Accountant', system: true, grants: all('all', ['view', 'create', 'edit', 'export', 'print'], ['billing', 'receipts', 'clients', 'reports']) },
  { key: 'admin', name: 'Admin / Office', system: true, grants: [...all('all', ACTIONS, ['settings', 'users', 'audit_log', 'registers', 'hr', 'dsc']), ...all('all', ['view'], ['clients'])] },
  { key: 'auditor', name: 'Auditor (read-only)', system: true, grants: all('all', ['view', 'export']).filter((g) => g.module !== 'vault') },
];
