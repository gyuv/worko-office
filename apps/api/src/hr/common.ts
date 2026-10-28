import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  attendanceDecision, canApprovePerson, canPerson, defaultHrSettings, effectiveScope, hrSettingsSchema, ipAllowed, istDate, nearestFence, roundCoord, skewMinutes,
  type Action, type HrSettings, type Module, type PersonCtx, type WorkCalendar,
} from '@worko/domain';
import type { RequestActor } from '../auth/context.js';
import { loadTeamIds } from '../auth/roles.repo.js';
import type { Params } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';

export type PersonModule = Extract<Module, 'time' | 'hr'>;

export async function loadHrSettings(tx: Tx): Promise<HrSettings> {
  const r = (await tx.query('SELECT settings FROM hr_settings LIMIT 1')).rows[0];
  if (!r) return defaultHrSettings();
  const p = hrSettingsSchema.safeParse(r.settings);
  return p.success ? p.data : defaultHrSettings();
}

/** Person context (branch, teams incl. led teams, manager) of a staff user, or null. */
export async function personOf(tx: Tx, userId: string): Promise<(PersonCtx & { name: string }) | null> {
  const u = (await tx.query(`SELECT id, name, branch_id, manager_id FROM app_user WHERE id = $1 AND deleted_at IS NULL`, [userId])).rows[0];
  if (!u) return null;
  return { userId: u.id, name: u.name, branchId: u.branch_id ?? null, managerId: u.manager_id ?? null, teamIds: await loadTeamIds(tx, u.id) };
}

/** Person whose records the actor may `action`; 404 when invisible (never confirm existence). */
export async function requirePerson(tx: Tx, a: RequestActor, module: PersonModule, action: Action, userId: string) {
  const p = await personOf(tx, userId);
  if (!p || !canPerson(a, module, action, p)) throw new NotFoundException();
  return p;
}
/** Approver check: manager or module:approve over the person; self-approval is refused with 403 (D86). */
export async function requireApprover(tx: Tx, a: RequestActor, module: PersonModule, userId: string) {
  const p = await personOf(tx, userId);
  if (!p) throw new NotFoundException();
  if (p.userId === a.userId) throw new ForbiddenException({ message: 'You cannot approve your own request', code: 'self_approval' });
  if (!canApprovePerson(a, module, p)) {
    if (!canPerson(a, module, 'view', p)) throw new NotFoundException();
    throw new ForbiddenException({ message: 'Only the manager or an approver can decide', code: 'not_approver' });
  }
  return p;
}

/**
 * SQL twin of `canPerson(actor, module, action, person(u))` over a user-id expression `u` (e.g. `x.user_id`).
 * Self needs some grant; the person's manager always; else all → TRUE, branch → same branch, team → shares a team.
 */
export function personScopeSql(a: RequestActor, module: PersonModule, action: Action, p: Params, u = 'x.user_id'): string {
  if (a.superAdmin) return 'TRUE';
  const g = effectiveScope(a, module, action);
  if (g?.scope === 'all') return 'TRUE';
  const me = p.add(a.userId);
  const has = !!g && g.scope !== 'none';
  const base = `((${u} = ${me}::uuid AND ${has ? 'TRUE' : 'FALSE'}) OR EXISTS (SELECT 1 FROM app_user pu WHERE pu.id = ${u} AND pu.manager_id = ${me}::uuid))`;
  if (!g || !has) return base;
  switch (g.scope) {
    case 'branch': return `(${base} OR EXISTS (SELECT 1 FROM app_user pu WHERE pu.id = ${u} AND pu.branch_id IS NOT DISTINCT FROM ${p.add(a.branchId)}::uuid))`;
    case 'team': {
      const teams = p.add(a.teamIds);
      return `(${base} OR EXISTS (SELECT 1 FROM team_member tm JOIN team tt ON tt.id = tm.team_id AND tt.deleted_at IS NULL WHERE tm.user_id = ${u} AND tm.team_id = ANY(${teams}::uuid[]))
        OR EXISTS (SELECT 1 FROM team tt WHERE tt.lead_user_id = ${u} AND tt.deleted_at IS NULL AND tt.id = ANY(${teams}::uuid[])))`;
    }
    default: return base;
  }
}

/** Requires any grant on the module for own-record actions (D85). */
export function requireOwn(a: RequestActor, module: PersonModule) {
  if (a.superAdmin) return;
  const ok = (['edit', 'create'] as const).some((x) => (effectiveScope(a, module, x)?.scope ?? 'none') !== 'none');
  if (!ok) throw new ForbiddenException(`Needs ${module}:edit`);
}

/** Holidays (firm-wide + the branch's) and the firm's work-week as a calendar. */
export async function calendarFor(tx: Tx, branchId: string | null, from: string, to: string, s?: HrSettings): Promise<WorkCalendar> {
  const set = s ?? await loadHrSettings(tx);
  const rows = (await tx.query(`SELECT to_char(on_date, 'YYYY-MM-DD') AS d FROM holiday WHERE deleted_at IS NULL AND NOT optional AND on_date BETWEEN $1::date AND $2::date
    AND (branch_id IS NULL OR branch_id IS NOT DISTINCT FROM $3::uuid)`, [from, to, branchId])).rows;
  return { weekendDays: set.workWeek.weekendDays, holidays: new Set(rows.map((r) => r.d as string)), excludeWeekends: set.workWeek.excludeWeekends, excludeHolidays: set.workWeek.excludeHolidays };
}

export type CheckInInput = { lat?: number | null; lng?: number | null; deviceAt?: Date | null; ip?: string | null; serverAt: Date; branchId: string | null; method: 'online' | 'offline' };
/**
 * Server-side evaluation of a check-in: nearest fence of the user's branch (or firm-wide fences), IP allow-list, policy,
 * clock skew. Coordinates are rounded before storage; raw values are never logged (D88).
 */
export async function evaluateCheckIn(tx: Tx, i: CheckInInput) {
  const s = await loadHrSettings(tx);
  const fences = (await tx.query(`SELECT id, lat, lng, radius_m FROM office_location WHERE deleted_at IS NULL AND active AND (branch_id IS NULL OR branch_id IS NOT DISTINCT FROM $1::uuid)`, [i.branchId])).rows
    .map((r) => ({ id: r.id as string, lat: Number(r.lat), lng: Number(r.lng), radiusM: r.radius_m as number }));
  const hasPoint = typeof i.lat === 'number' && typeof i.lng === 'number';
  const near = hasPoint && fences.length ? nearestFence({ lat: i.lat!, lng: i.lng! }, fences) : null;
  const inFence = hasPoint ? (fences.length ? !!near?.inside : false) : null;
  const ipOk = i.ip ? ipAllowed(i.ip, s.attendance.ipAllowList) : null;
  const d = attendanceDecision(s.attendance, { inFence, ipOk });
  const flags = [...d.flags];
  let status: string = d.status;
  const skew = skewMinutes(i.deviceAt, i.serverAt);
  if (skew > s.attendance.skewFlagMinutes) {
    flags.push('clock_skew');
    if (status === 'ok') status = s.attendance.outside === 'approval' ? 'needs_approval' : 'flagged';
  }
  // The attendance day is the device-claimed IST date when the clocks agree, else the server's.
  const day = istDate(skew > s.attendance.skewFlagMinutes || !i.deviceAt ? i.serverAt : i.deviceAt);
  return {
    work_date: day, check_in_at: i.serverAt.toISOString(), device_check_in_at: i.deviceAt ? i.deviceAt.toISOString() : null,
    in_lat: hasPoint ? roundCoord(i.lat!) : null, in_lng: hasPoint ? roundCoord(i.lng!) : null,
    location_id: near?.id ?? null, distance_m: near?.distanceM ?? null, in_fence: inFence, ip_ok: ipOk, method: i.method, flags, status,
  };
}

export const isoDay = (v: unknown): string | null => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : typeof v === 'string' ? v.slice(0, 10) : null);
export const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
