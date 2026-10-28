import { addDaysIso, mondayOf, weekdayOf } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import { InvoicesService } from '../billing/invoices.service.js';
import { Clock } from '../common/clock.js';
import { ExpensesService } from '../hr/expenses.service.js';
import { LeaveService } from '../hr/leave.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SYNC_TABLES } from '../sync/registry.js';
import { SyncService } from '../sync/sync.service.js';
import { systemActor } from '../tasks/system-actor.js';
import type { DbService } from './db.service.js';
import { uuidv7 } from './ids.js';

/** Hourly cost per role (demo data, paise). */
const COST: Record<string, number> = { partner: 300_000, manager: 150_000, senior: 90_000, article: 40_000, accountant: 60_000 };

/**
 * Phase 6 demo data, deterministic for `today`: firm holidays, the Pune office geofence, cost rates, three weeks of time
 * (older weeks approved, last week submitted), attendance with one out-of-fence day, leave types + opening balances +
 * requests (an article's study leave, partly approved), a comp-off grant for Sunday work, an expense claim with partial
 * approval settled against an advance, and one billable expense linked to an invoice reimbursement line.
 */
export async function seedHr(db: DbService, tenantId: string, today: string) {
  const audit = new AuditService(); const realtime = new RealtimeService();
  const clock = new Clock(new Date(`${today}T18:00:00+05:30`));
  const sync = new SyncService(db, audit, realtime, SYNC_TABLES, clock);
  const leave = new LeaveService(db, sync, audit, realtime, new JobQueueService(db), clock);
  const expenses = new ExpensesService(db, audit, clock);
  const invoices = new InvoicesService(db, audit, sync, realtime, clock);
  const sys = systemActor(tenantId);
  const { users, actors, clientA, leaveTypes } = await db.tenantTx(tenantId, async (tx) => {
    const rows = (await tx.query(`SELECT u.id, u.branch_id, r.key FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id ORDER BY u.id`)).rows;
    const users: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key, r.id]));
    const actors: Record<string, RequestActor> = {};
    for (const r of rows) actors[r.key] = { userId: r.id, tenantId, sessionId: '', deviceId: 'seed', branchId: r.branch_id, teamIds: await loadTeamIds(tx, r.id), roles: await loadUserRoles(tx, r.id) };
    const branch = (await tx.query('SELECT id FROM branch ORDER BY id LIMIT 1')).rows[0].id;
    await tx.query(`INSERT INTO hr_settings (tenant_id, settings) VALUES ($1, $2)`, [tenantId, JSON.stringify({ attendance: { mode: 'either', outside: 'flag', ipAllowList: ['203.0.113.0/24'] } })]);
    await tx.query(`INSERT INTO office_location (id, tenant_id, branch_id, name, lat, lng, radius_m) VALUES ($1,$2,$3,'Shivaji Nagar office',18.5308,73.8475,150)`, [uuidv7(), tenantId, branch]);
    // Holidays: one in the past fortnight (a weekday), one ahead.
    let h = addDaysIso(today, -10); while (weekdayOf(h) === 0) h = addDaysIso(h, -1);
    await tx.query(`INSERT INTO holiday (id, tenant_id, on_date, name) VALUES ($1,$2,$3,'Firm holiday (demo)'), ($4,$2,$5,'Diwali (demo)')`, [uuidv7(), tenantId, h, uuidv7(), addDaysIso(today, 18)]);
    for (const [k, id] of Object.entries(users)) {
      await tx.query('INSERT INTO cost_rate (id, tenant_id, user_id, hourly_paise, effective_from, notes) VALUES ($1,$2,$3,$4,$5,$6)', [uuidv7(), tenantId, id, COST[k] ?? 50_000, `${today.slice(0, 4)}-01-01`, 'Demo cost rate']);
    }
    const lt: Record<string, string> = {};
    for (const [key, name, extra] of [
      ['casual', 'Casual leave', { accrual: { kind: 'monthly', days: 1 }, carry_forward_cap: 6 }],
      ['sick', 'Sick leave', { accrual: { kind: 'annual', days: 7 }, carry_forward_cap: 0 }],
      ['earned', 'Earned leave', { accrual: { kind: 'annual', days: 15 }, carry_forward_cap: 30, allow_half_day: false }],
      ['comp_off', 'Comp-off', { comp_off: true, accrual: { kind: 'none', days: 0 } }],
      ['study', 'Study leave (articles)', { applies_to_roles: ['article'], allow_half_day: false, accrual: { kind: 'none', days: 0 } }],
      ['exam', 'Exam leave (articles)', { applies_to_roles: ['article'], tracked: false, allow_half_day: false, accrual: { kind: 'none', days: 0 } }],
    ] as Array<[string, string, Record<string, unknown>]>) {
      const id = uuidv7(); lt[key] = id;
      await tx.query(`INSERT INTO leave_type (id, tenant_id, key, name, accrual, carry_forward_cap, allow_half_day, comp_off, applies_to_roles, tracked)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, tenantId, key, name, JSON.stringify(extra.accrual), extra.carry_forward_cap ?? null, extra.allow_half_day ?? true, !!extra.comp_off, extra.applies_to_roles ?? [], extra.tracked ?? true]);
    }
    for (const [key, days] of [['casual', 6], ['sick', 7], ['earned', 12], ['study', 10]] as const) {
      for (const [role, uid] of Object.entries(users)) {
        if (key === 'study' && role !== 'article') continue;
        await tx.query(`INSERT INTO leave_ledger (id, tenant_id, user_id, leave_type_id, delta, reason, ref_key, on_date, note) VALUES ($1,$2,$3,$4,$5,'opening','opening',$6,'Opening balance (demo)')`,
          [uuidv7(), tenantId, uid, lt[key], days, `${today.slice(0, 7)}-01`]);
      }
    }
    for (const t of [['travel', 'Local travel', 50_000, 'warn'], ['meals', 'Meals', 75_000, 'warn'], ['roc_fees', 'ROC / government fees', 1_000_000, 'block'], ['courier', 'Courier', null, 'warn']] as const) {
      await tx.query('INSERT INTO expense_category (id, tenant_id, key, name, limit_paise, limit_mode) VALUES ($1,$2,$3,$4,$5,$6)', [uuidv7(), tenantId, t[0], t[1], t[2], t[3]]);
    }
    // Time: three weeks for the manager, senior and article on their own tasks (older weeks approved, last week submitted).
    const thisWeek = mondayOf(today);
    for (const role of ['manager', 'senior', 'article'] as const) {
      const uid = users[role]!;
      const tasks = (await tx.query(`SELECT id, client_id FROM task WHERE assignee_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 4`, [uid])).rows;
      const fallback = (await tx.query(`SELECT id FROM client WHERE $1 = ANY(staff_ids) OR manager_id = $1 ORDER BY file_no LIMIT 1`, [uid])).rows[0]?.id ?? null;
      for (let w = 3; w >= 1; w--) {
        const monday = addDaysIso(thisWeek, -7 * w);
        for (let d = 0; d < 5; d++) {
          const day = addDaysIso(monday, d);
          const tk = tasks[(d + w) % Math.max(1, tasks.length)];
          const status = w === 1 ? 'submitted' : 'approved';
          await tx.query(`INSERT INTO time_entry (id, tenant_id, user_id, task_id, client_id, work_date, minutes, billable, notes, status, submitted_at, decided_by, decided_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [uuidv7(), tenantId, uid, tk?.id ?? null, tk?.client_id ?? fallback, day, 240 + ((d * 37 + w * 11) % 180), d !== 4, 'Demo time', status, `${addDaysIso(monday, 5)}T10:00:00+05:30`,
              status === 'approved' ? (role === 'manager' ? users.partner : users.manager) : null, status === 'approved' ? `${addDaysIso(monday, 6)}T10:00:00+05:30` : null]);
        }
      }
    }
    // Sunday work by the article two weeks ago (approved) → comp-off below.
    const sunday = addDaysIso(thisWeek, -8);
    await tx.query(`INSERT INTO time_entry (id, tenant_id, user_id, client_id, work_date, minutes, notes, status, decided_by, decided_at)
      SELECT $1, $2, $3, id, $4, 300, 'Sunday filing rush (demo)', 'approved', $5, now() FROM client WHERE $3 = ANY(staff_ids) ORDER BY file_no LIMIT 1`, [uuidv7(), tenantId, users.article, sunday, users.manager]);
    // Attendance for the last five working days; the senior once outside the fence (flagged).
    for (let k = 1, n = 0; n < 5; k++) {
      const day = addDaysIso(today, -k);
      if (weekdayOf(day) === 0 || day === h) continue;
      n++;
      for (const role of ['senior', 'article'] as const) {
        const out = role === 'senior' && n === 2;
        await tx.query(`INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, check_out_at, device_check_in_at, in_lat, in_lng, location_id, distance_m, in_fence, ip_ok, flags, status, minutes)
          SELECT $1,$2,$3,$4,$5,$6,$5,$7,$8,id,$9,$10,false,$11,$12,510 FROM office_location LIMIT 1`,
          [uuidv7(), tenantId, users[role], day, `${day}T09:${role === 'article' ? '20' : '45'}:00+05:30`, `${day}T18:${role === 'article' ? '50' : '15'}:00+05:30`,
            out ? 18.5521 : 18.5309, out ? 73.8302 : 73.8476, out ? 2780 : 11, !out, out ? ['out_of_fence'] : [], out ? 'flagged' : 'ok']);
      }
    }
    const clientA = (await tx.query(`SELECT id FROM client WHERE $1 = ANY(staff_ids) AND NOT sensitive ORDER BY file_no LIMIT 1`, [users.article])).rows[0].id as string;
    return { users, actors, clientA, leaveTypes: lt };
  });

  // Leave: the article's study leave next week (3 days, 2 approved), the senior's casual leave pending, comp-off for Sunday work.
  const nextMon = addDaysIso(mondayOf(today), 7);
  const study = await leave.apply(actors.article!, { leaveTypeId: leaveTypes.study!, from: nextMon, to: addDaysIso(nextMon, 2), reason: 'CA Intermediate exam preparation' });
  await leave.decide(actors.manager!, study.id, { approve: true, approvedTo: addDaysIso(nextMon, 1), note: 'Wednesday needed for the audit (demo)' });
  await leave.apply(actors.article!, { leaveTypeId: leaveTypes.exam!, from: addDaysIso(nextMon, 3), to: addDaysIso(nextMon, 3), reason: 'CA Intermediate paper 1' });
  await leave.apply(actors.senior!, { leaveTypeId: leaveTypes.casual!, from: addDaysIso(nextMon, 4), to: addDaysIso(nextMon, 4), startHalf: true, reason: 'Family function' });
  await leave.runCompOff(sys, addDaysIso(mondayOf(today), -8), addDaysIso(mondayOf(today), -8));

  // Expenses: an advance (approved lower, paid), a claim with a capped travel line and a billable ROC fee, paid net of the advance.
  const adv = await expenses.requestAdvance(actors.article!, { purpose: 'Outstation stock audit (demo)', amountPaise: 300_000 });
  await expenses.decideAdvance(actors.manager!, adv.id, { approve: true, approvedPaise: 200_000 });
  await expenses.payAdvance(actors.partner!, adv.id, { reference: 'NEFT ADV001' });
  const spent = addDaysIso(today, -3);
  const claim = await expenses.create(actors.article!, { title: 'Client visits and ROC filing (demo)', submit: true, lines: [
    { categoryKey: 'travel', spentOn: spent, description: 'Cab to client office and back', amountPaise: 65_000 },
    { categoryKey: 'meals', spentOn: spent, description: 'Lunch during audit', amountPaise: 30_000 },
    { categoryKey: 'roc_fees', spentOn: spent, description: 'MCA filing fee paid for client', amountPaise: 60_000, clientId: clientA, billable: true },
  ] });
  const detail = await expenses.get(sys, claim.id);
  await expenses.decide(actors.manager!, claim.id, { approve: true, lines: [{ id: detail.lines[0]!.id as string, approvedPaise: 50_000, note: 'Capped at the travel policy' }], note: 'Travel capped (demo)' });
  await expenses.pay(actors.partner!, claim.id, { reference: 'NEFT EXP001' });
  const [billable] = (await expenses.reimbursable(sys, { clientId: clientA })).items;
  if (billable) {
    const inv = await invoices.create(sys, { clientId: clientA, notes: 'Reimbursement of fees paid on your behalf (demo)', lines: [billable.suggestedLine] });
    const line = (await invoices.get(sys, inv.id)).lines[0]!;
    await expenses.link(actors.partner!, billable.id as string, line.id as string);
  }
  return { users };
}
