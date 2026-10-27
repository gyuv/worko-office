import { can, clientCtx, SYSTEM_ROLES, type Actor, type Grant, type Role } from '@worko/domain';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientScopeSql, Params } from '../src/clients/scope.js';
import { freshDatabase } from './db.js';

/** Property test: the SQL visibility filter must agree with `can()` for every (actor, client) pair. */
let db: Awaited<ReturnType<typeof freshDatabase>>;
let c: pg.Client;
beforeAll(async () => { db = await freshDatabase(); c = new pg.Client({ connectionString: db.url }); await c.connect(); });
afterAll(async () => { await c.end(); await db.drop(); });

describe('clientScopeSql ≡ can()', () => {
  it('agrees on 3000 random actor/client pairs', async () => {
    let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const users = Array.from({ length: 5 }, () => randomUUID());
    const branches = [randomUUID(), randomUUID()]; const teams = [randomUUID(), randomUUID()]; const groups = [randomUUID(), randomUUID(), randomUUID()];
    const sub = <T,>(xs: T[]) => xs.filter(() => rnd() < 0.35);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const custom: Role = { key: 'x', name: 'x', system: false, grants: [{ module: 'clients', action: 'view', scope: pick(['own', 'team', 'branch', 'groups', 'all', 'none'] as const), clientGroupIds: sub(groups) } as Grant] };
      const actor: Actor = { userId: pick(users), teamIds: sub(teams), branchId: rnd() < 0.8 ? pick(branches) : null, roles: [rnd() < 0.3 ? pick(SYSTEM_ROLES) : custom] };
      const rows = Array.from({ length: 10 }, () => ({
        branchId: rnd() < 0.8 ? pick(branches) : null, partnerId: rnd() < 0.5 ? pick(users) : null, managerId: rnd() < 0.5 ? pick(users) : null,
        teamId: rnd() < 0.6 ? pick(teams) : null, staffIds: sub(users), groupIds: sub(groups), sensitive: rnd() < 0.3, allowedUserIds: sub(users),
      }));
      const p = new Params();
      const where = clientScopeSql(actor, 'clients', 'view', p);
      const values = rows.map((r, idx) => {
        const v = [r.branchId, r.partnerId, r.managerId, r.teamId, r.staffIds, r.groupIds, r.sensitive, r.allowedUserIds].map((x) => p.add(x));
        return `(${idx}, ${v[0]}::uuid, ${v[1]}::uuid, ${v[2]}::uuid, ${v[3]}::uuid, ${v[4]}::uuid[], ${v[5]}::uuid[], ${v[6]}::boolean, ${v[7]}::uuid[])`;
      });
      const sql = `SELECT idx FROM (VALUES ${values.join(',')}) AS c(idx, branch_id, partner_id, manager_id, team_id, staff_ids, group_ids, sensitive, allowed_user_ids) WHERE ${where}`;
      const got = new Set((await c.query(sql, p.values)).rows.map((r) => r.idx));
      rows.forEach((r, idx) => { expect(got.has(idx), JSON.stringify({ actor, r })).toBe(can(actor, 'clients', 'view', clientCtx(r))); checked++; });
    }
    expect(checked).toBe(3000);
  });
});
