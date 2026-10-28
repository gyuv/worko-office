import { Injectable } from '@nestjs/common';
import { addDaysIso, allocateByWeight, canSeeCost, costPaise, effectiveScope, mondayOf, pnlOf, utilisationPct, weekCapacity } from '@worko/domain';
import type { RequestActor } from '../auth/context.js';
import { rateFor } from '../billing/auto.service.js';
import { clientScopeSql, Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { calendarFor, loadHrSettings, personScopeSql } from '../hr/common.js';

type Group = { key: string; label: string; clientId: string | null; clientName: string | null; taskId: string | null; serviceTypeId: string | null;
  revenuePaise: number; costPaise: number; wipPaise: number; minutes: number; billableMinutes: number };

/** Effective hourly cost of a user on a date (latest effective_from ≤ date, not ended). */
export async function costRates(tx: Tx): Promise<(userId: string, on: string) => number> {
  const rows = (await tx.query(`SELECT user_id, hourly_paise, to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t FROM cost_rate
    WHERE deleted_at IS NULL ORDER BY effective_from DESC`)).rows;
  return (userId, on) => Number(rows.find((r) => r.user_id === userId && r.f <= on && (!r.t || r.t >= on))?.hourly_paise ?? 0);
}

@Injectable()
export class TimeReportsService {
  constructor(private db: DbService, private clock: Clock) {}

  /**
   * Job P&L (D90). Revenue = taxable value of issued (non-cancelled) invoice lines linked to tasks, issued in [from, to], split
   * equally over a line's tasks, net of credit notes against those invoices (allocated over the invoice's taxable lines by
   * value). Cost = approved minutes in [from, to] × the user's cost rate on the entry date. WIP = unbilled tasks with
   * approved time: rate-table fee, else cost. Only clients visible for clients:view AND reports:view; firm work needs
   * firm-wide reports:view. Cost/margin are null without cost visibility (D87).
   */
  jobPnl(a: RequestActor, q: { from: string; to: string; groupBy: 'task' | 'client' | 'service' }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const showCost = canSeeCost(a);
      const firm = !!a.superAdmin || effectiveScope(a, 'reports', 'view')?.scope === 'all';
      const p = new Params();
      const vis = new Map((await tx.query(`SELECT c.id, c.name, c.group_ids FROM client c WHERE c.deleted_at IS NULL AND ${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'reports', 'view', p)}`, p.values)).rows
        .map((r) => [r.id as string, r as { id: string; name: string; group_ids: string[] }]));
      const ok = (clientId: string | null) => (clientId ? vis.has(clientId) : firm);
      const tasks = new Map<string, Record<string, unknown>>();
      const taskOf = async (id: string) => {
        if (!tasks.has(id)) tasks.set(id, (await tx.query('SELECT t.id, t.title, t.client_id, t.service_type_id, t.outcome, t.status, s.name AS service_name FROM task t LEFT JOIN service_type s ON s.id = t.service_type_id WHERE t.id = $1', [id])).rows[0]);
        return tasks.get(id)!;
      };
      const services = new Map((await tx.query('SELECT id, name FROM service_type')).rows.map((r) => [r.id as string, r.name as string]));
      const groups = new Map<string, Group>();
      const keyOf = (t: Record<string, unknown> | null, clientId: string | null): Pick<Group, 'key' | 'label' | 'taskId' | 'serviceTypeId'> => {
        const cName = clientId ? vis.get(clientId)?.name ?? '' : 'Firm';
        if (q.groupBy === 'client') return { key: clientId ?? 'firm', label: cName, taskId: null, serviceTypeId: null };
        if (q.groupBy === 'service') { const s = (t?.service_type_id as string) ?? null; return { key: s ?? 'none', label: s ? services.get(s) ?? '' : 'No service', taskId: null, serviceTypeId: s }; }
        return t ? { key: t.id as string, label: `${cName} — ${t.title}`, taskId: t.id as string, serviceTypeId: (t.service_type_id as string) ?? null }
          : { key: `notask:${clientId ?? 'firm'}`, label: `${cName} — (no task)`, taskId: null, serviceTypeId: null };
      };
      const g = (t: Record<string, unknown> | null, clientId: string | null) => {
        const k = keyOf(t, clientId);
        let x = groups.get(k.key);
        if (!x) {
          x = { ...k, clientId: q.groupBy === 'service' ? null : clientId, clientName: q.groupBy === 'service' ? null : clientId ? vis.get(clientId)?.name ?? null : null, revenuePaise: 0, costPaise: 0, wipPaise: 0, minutes: 0, billableMinutes: 0 };
          groups.set(k.key, x);
        }
        return x;
      };

      // Revenue
      const lines = (await tx.query(`SELECT l.id, l.invoice_id, l.taxable_paise, NOT l.reimbursement AS taxable, i.client_id,
          ARRAY(SELECT it.task_id FROM invoice_task it WHERE it.line_id = l.id AND it.live ORDER BY it.task_id) AS task_ids
        FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id WHERE i.kind = 'invoice' AND i.status NOT IN ('draft','cancelled') AND i.deleted_at IS NULL
          AND i.issue_date BETWEEN $1::date AND $2::date ORDER BY l.invoice_id, l.sort, l.id`, [q.from, q.to])).rows;
      const cn = new Map((await tx.query(`SELECT against_invoice_id AS id, sum(taxable_paise) AS s FROM invoice WHERE kind = 'credit_note' AND status <> 'cancelled' AND deleted_at IS NULL
        AND against_invoice_id = ANY($1::uuid[]) GROUP BY against_invoice_id`, [[...new Set(lines.map((l) => l.invoice_id))]])).rows.map((r) => [r.id as string, Number(r.s)]));
      let creditPaise = 0;
      for (const invId of new Set(lines.map((l) => l.invoice_id as string))) {
        const ls = lines.filter((l) => l.invoice_id === invId && l.taxable);
        if (!ok(ls[0]?.client_id ?? null)) continue;
        const credit = allocateByWeight(-(cn.get(invId) ?? 0), ls.map((l) => Number(l.taxable_paise)));
        for (const [k, l] of ls.entries()) {
          if (!l.task_ids.length) continue;
          const net = Number(l.taxable_paise) + credit[k]!;
          creditPaise -= credit[k]!;
          const shares = allocateByWeight(net, l.task_ids.map(() => 1));
          for (const [j, tid] of (l.task_ids as string[]).entries()) g(await taskOf(tid), l.client_id).revenuePaise += shares[j]!;
        }
      }

      // Cost (approved time, reversals included)
      const rate = await costRates(tx);
      const te = (await tx.query(`SELECT x.user_id, x.task_id, COALESCE(t.client_id, x.client_id) AS client_id, to_char(x.work_date,'YYYY-MM-DD') AS d, x.minutes, x.billable
        FROM time_entry x LEFT JOIN task t ON t.id = x.task_id WHERE x.status = 'approved' AND x.deleted_at IS NULL AND x.work_date BETWEEN $1::date AND $2::date ORDER BY x.id`, [q.from, q.to])).rows;
      const wipCost = new Map<string, number>();
      for (const e of te) {
        if (!ok(e.client_id)) continue;
        const t = e.task_id ? await taskOf(e.task_id) : null;
        const x = g(t, e.client_id);
        const c = costPaise(e.minutes, rate(e.user_id, e.d));
        x.costPaise += c; x.minutes += e.minutes; if (e.billable) x.billableMinutes += e.minutes;
        if (t && !t.outcome && t.status !== 'cancelled' && e.billable) wipCost.set(t.id as string, (wipCost.get(t.id as string) ?? 0) + c);
      }
      // WIP: unbilled tasks with approved billable time → fee from the rate table, else the time at cost.
      for (const [tid, c] of wipCost) {
        const t = tasks.get(tid)!;
        const client = t.client_id ? vis.get(t.client_id as string) : undefined;
        const fee = t.service_type_id && client ? await rateFor(tx, t.service_type_id as string, client, q.to) : null;
        g(t, (t.client_id as string) ?? null).wipPaise += fee ?? Math.max(0, c);
      }

      const items = [...groups.values()].map((x) => {
        const r = pnlOf({ revenuePaise: x.revenuePaise, costPaise: showCost ? x.costPaise : null, wipPaise: x.wipPaise, minutes: x.minutes });
        return { ...x, ...r, costPaise: showCost ? x.costPaise : null };
      }).sort((x, y) => (x.marginPaise ?? 0) - (y.marginPaise ?? 0) || x.label.localeCompare(y.label));
      const sum = (f: (x: Group) => number) => [...groups.values()].reduce((s, x) => s + f(x), 0);
      const totals = pnlOf({ revenuePaise: sum((x) => x.revenuePaise), costPaise: showCost ? sum((x) => x.costPaise) : null, wipPaise: sum((x) => x.wipPaise), minutes: sum((x) => x.minutes) });
      return { from: q.from, to: q.to, groupBy: q.groupBy, costVisible: showCost, creditNotesPaise: creditPaise, totals, items, lossMaking: items.filter((x) => x.loss).length };
    });
  }

  /**
   * Capacity heat map (D91): per visible user × ISO week, capacity (weekly minutes over working days, minus holidays and
   * approved leave), planned (estimates of open tasks assigned to them, by act-by/statutory due) and actual (approved time).
   */
  capacity(a: RequestActor, q: { weeks: number; from?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await loadHrSettings(tx);
      const start = mondayOf(q.from ?? this.clock.todayIst());
      const end = addDaysIso(start, q.weeks * 7 - 1);
      const p = new Params();
      const users = (await tx.query(`SELECT u.id, u.name, u.branch_id, COALESCE(h.weekly_capacity_minutes, ${p.add(s.capacity.defaultWeeklyMinutes)}::int) AS weekly
        FROM app_user u LEFT JOIN hr_profile h ON h.user_id = u.id WHERE u.deleted_at IS NULL AND u.status = 'active' AND u.kind = 'staff' AND ${personScopeSql(a, 'time', 'view', p, 'u.id')}
        ORDER BY lower(u.name), u.id`, p.values)).rows;
      const weeks = Array.from({ length: q.weeks }, (_, k) => addDaysIso(start, k * 7));
      const ids = users.map((u) => u.id);
      const leaves = (await tx.query(`SELECT user_id, to_char(approved_from,'YYYY-MM-DD') AS f, to_char(approved_to,'YYYY-MM-DD') AS t, approved_start_half AS sh, approved_end_half AS eh
        FROM leave_request WHERE user_id = ANY($1::uuid[]) AND status IN ('approved','partially_approved') AND deleted_at IS NULL AND approved_from <= $3::date AND approved_to >= $2::date`, [ids, start, end])).rows;
      const planned = (await tx.query(`SELECT assignee_id AS u, to_char(COALESCE(act_by, statutory_due),'YYYY-MM-DD') AS d, estimate_minutes AS m FROM task
        WHERE assignee_id = ANY($1::uuid[]) AND deleted_at IS NULL AND outcome IS NULL AND status NOT IN ('done','cancelled') AND estimate_minutes > 0
          AND COALESCE(act_by, statutory_due) BETWEEN $2::date AND $3::date`, [ids, start, end])).rows;
      const actual = (await tx.query(`SELECT user_id AS u, to_char(work_date,'YYYY-MM-DD') AS d, sum(minutes) AS m FROM time_entry WHERE user_id = ANY($1::uuid[]) AND status = 'approved'
        AND deleted_at IS NULL AND work_date BETWEEN $2::date AND $3::date GROUP BY 1, 2`, [ids, start, end])).rows;
      const out = [];
      for (const u of users) {
        const cal = await calendarFor(tx, u.branch_id, start, end, s);
        const lv = new Map<string, number>();
        for (const l of leaves.filter((x) => x.user_id === u.id)) {
          for (let d = l.f as string; d <= l.t; d = addDaysIso(d, 1)) lv.set(d, Math.min(1, (lv.get(d) ?? 0) + ((d === l.f && l.sh) || (d === l.t && l.eh) ? 0.5 : 1)));
        }
        const cells = weeks.map((w) => {
          const we = addDaysIso(w, 6);
          const c = weekCapacity(w, Number(u.weekly), cal, lv);
          const pl = planned.filter((x) => x.u === u.id && x.d >= w && x.d <= we).reduce((acc, x) => acc + Number(x.m), 0);
          const ac = actual.filter((x) => x.u === u.id && x.d >= w && x.d <= we).reduce((acc, x) => acc + Number(x.m), 0);
          return { weekStart: w, ...c, plannedMinutes: pl, actualMinutes: ac, plannedPct: utilisationPct(pl, c.capacityMinutes), actualPct: utilisationPct(ac, c.capacityMinutes) };
        });
        out.push({ userId: u.id, name: u.name, weeklyCapacityMinutes: Number(u.weekly), weeks: cells });
      }
      return { from: start, to: end, weeks, users: out };
    });
  }
}

