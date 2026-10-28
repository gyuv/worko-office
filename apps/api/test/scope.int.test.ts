import { can, canTask, clientCtx, SYSTEM_ROLES, type Actor, type Grant, type Role } from '@worko/domain';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientScopeSql, Params } from '../src/clients/scope.js';
import { taskScopeSql } from '../src/tasks/scope.js';
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

describe('taskScopeSql ≡ canTask()', () => {
  it('agrees on 3000 random actor/task pairs (client and firm tasks)', async () => {
    let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const users = Array.from({ length: 5 }, () => randomUUID());
    const branches = [randomUUID(), randomUUID()]; const teams = [randomUUID(), randomUUID()]; const groups = [randomUUID(), randomUUID(), randomUUID()];
    const sub = <T,>(xs: T[]) => xs.filter(() => rnd() < 0.35);
    const scopes = ['own', 'team', 'branch', 'groups', 'all', 'none'] as const;
    const maybe = () => (rnd() < 0.4 ? pick(users) : null);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const custom: Role = { key: 'x', name: 'x', system: false, grants: [
        { module: 'clients', action: 'view', scope: pick(scopes), clientGroupIds: sub(groups) } as Grant,
        { module: 'tasks', action: 'view', scope: pick(scopes), clientGroupIds: sub(groups) } as Grant,
      ] };
      const actor: Actor = { userId: pick(users), teamIds: sub(teams), branchId: rnd() < 0.8 ? pick(branches) : null, roles: [rnd() < 0.3 ? pick(SYSTEM_ROLES) : custom] };
      const rows = Array.from({ length: 10 }, () => ({
        firm: rnd() < 0.25,
        people: { leaderId: maybe(), managerId: maybe(), assigneeId: maybe(), reviewerId: maybe() },
        client: {
          branchId: rnd() < 0.8 ? pick(branches) : null, partnerId: rnd() < 0.5 ? pick(users) : null, managerId: rnd() < 0.5 ? pick(users) : null,
          teamId: rnd() < 0.6 ? pick(teams) : null, staffIds: sub(users), groupIds: sub(groups), sensitive: rnd() < 0.3, allowedUserIds: sub(users),
        },
      }));
      const p = new Params();
      const where = taskScopeSql(actor, 'view', p, 't', 'c');
      const values = rows.map((r, idx) => {
        const n = (x: unknown) => p.add(r.firm ? null : x);
        const v = [r.firm ? null : randomUUID(), r.people.leaderId, r.people.managerId, r.people.assigneeId, r.people.reviewerId].map((x) => p.add(x));
        const cv = [r.client.branchId, r.client.partnerId, r.client.managerId, r.client.teamId, r.client.staffIds, r.client.groupIds, r.client.sensitive, r.client.allowedUserIds].map(n);
        return `(${idx}, ${v[0]}::uuid, ${v[1]}::uuid, ${v[2]}::uuid, ${v[3]}::uuid, ${v[4]}::uuid, ${cv[0]}::uuid, ${cv[1]}::uuid, ${cv[2]}::uuid, ${cv[3]}::uuid, ${cv[4]}::uuid[], ${cv[5]}::uuid[], ${cv[6]}::boolean, ${cv[7]}::uuid[])`;
      });
      const sql = `SELECT idx FROM (VALUES ${values.join(',')}) AS v(idx, client_id, leader_id, manager_id, assignee_id, reviewer_id, branch_id, partner_id, c_manager_id, team_id, staff_ids, group_ids, sensitive, allowed_user_ids)
        CROSS JOIN LATERAL (SELECT v.client_id, v.leader_id, v.manager_id, v.assignee_id, v.reviewer_id) AS t
        CROSS JOIN LATERAL (SELECT v.branch_id, v.partner_id, v.c_manager_id AS manager_id, v.team_id, v.staff_ids, v.group_ids, v.sensitive, v.allowed_user_ids) AS c
        WHERE ${where}`;
      const got = new Set((await c.query(sql, p.values)).rows.map((r) => r.idx));
      rows.forEach((r, idx) => {
        expect(got.has(idx), JSON.stringify({ actor, r })).toBe(canTask(actor, 'view', r.people, r.firm ? null : r.client));
        checked++;
      });
    }
    expect(checked).toBe(3000);
  });
});
