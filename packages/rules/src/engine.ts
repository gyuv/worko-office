import { addDays, addMonths, daysInMonth, fmt, lastDay, parse, weekday } from './dates.js';
import type { ClientFacts, Condition, DueExpr, DueItem, Extension, Period, Predicate, Rule, RulePack } from './types.js';
import { rulePackSchema } from './types.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fyl = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;

export function loadPack(json: unknown): RulePack {
  const pack = rulePackSchema.parse(json);
  const ids = new Set<string>();
  for (const r of pack.rules) {
    const k = `${r.id}@${r.effectiveFrom}`;
    if (ids.has(k)) throw new Error(`Duplicate rule ${k}`);
    ids.add(k);
  }
  return pack;
}

function test(c: Condition, facts: ClientFacts): boolean {
  const v = facts[c.field];
  switch (c.op) {
    case 'eq': return v === c.value;
    case 'neq': return v !== c.value;
    case 'in': return Array.isArray(c.value) && c.value.includes(v);
    case 'nin': return Array.isArray(c.value) && !c.value.includes(v);
    case 'gt': return Number(v) > Number(c.value);
    case 'gte': return Number(v) >= Number(c.value);
    case 'lt': return Number(v) < Number(c.value);
    case 'lte': return Number(v) <= Number(c.value);
    case 'truthy': return !!v;
  }
}

export function matches(p: Predicate | undefined, facts: ClientFacts): boolean {
  if (!p) return true;
  if (p.all && !p.all.every((c) => test(c, facts))) return false;
  if (p.any && p.any.length && !p.any.some((c) => test(c, facts))) return false;
  return true;
}

/** Periods of a rule within FY starting `fy`. */
export function periodsForFy(rule: Rule, fy: number): Period[] {
  const out: Period[] = [];
  if (rule.frequency === 'monthly') {
    for (let i = 0; i < 12; i++) {
      const { y, m } = addMonths(fy, 4, i);
      out.push({ key: `${y}-${String(m).padStart(2, '0')}`, start: fmt({ y, m, d: 1 }), end: lastDay(y, m), label: `${MON[m - 1]} ${y}` });
    }
  } else if (rule.frequency === 'quarterly') {
    for (let q = 0; q < 4; q++) {
      const s = addMonths(fy, 4, q * 3); const e = addMonths(fy, 4, q * 3 + 2);
      out.push({ key: `FY${fyl(fy)}-Q${q + 1}`, start: fmt({ ...s, d: 1 }), end: lastDay(e.y, e.m), label: `Q${q + 1} FY ${fyl(fy)}` });
    }
  } else if (rule.frequency === 'annual') {
    out.push({ key: `FY${fyl(fy)}`, start: `${fy}-04-01`, end: `${fy + 1}-03-31`, label: `FY ${fyl(fy)}` });
  }
  return out;
}

export function evalDue(expr: DueExpr, period: Period): string {
  const base = (() => {
    const s = parse(period.start); const e = parse(period.end);
    const fyStart = s.m >= 4 ? s.y : s.y - 1;
    switch (expr.anchor) {
      case 'period_start': return { y: s.y, m: s.m };
      case 'period_end': return { y: e.y, m: e.m };
      case 'fy_start': return { y: fyStart, m: 4 };
      case 'fy_end': return { y: fyStart + 1, m: 3 };
    }
  })();
  const { y, m } = addMonths(base.y, base.m, expr.addMonths);
  const dim = daysInMonth(y, m);
  const d = expr.day === 'last' ? dim : Math.min(expr.day, dim);
  return fmt({ y, m, d });
}

export type HolidayCalendar = { isHoliday(date: string): boolean };
/** Sundays + supplied list (per branch/state in practice). */
export const holidayCalendar = (dates: string[] = [], weekends: number[] = [0]): HolidayCalendar => {
  const set = new Set(dates);
  return { isHoliday: (d) => set.has(d) || weekends.includes(weekday(d)) };
};

export function shift(date: string, policy: Rule['holidayShift'], cal: HolidayCalendar): string {
  if (policy === 'none') return date;
  const step = policy === 'next_working_day' ? 1 : -1;
  let d = date;
  for (let i = 0; i < 31 && cal.isHoliday(d); i++) d = addDays(d, step);
  return d;
}

/** The rule version in force for a period (by period start). */
export function ruleInForce(pack: RulePack, ruleId: string, periodStart: string): Rule | undefined {
  return pack.rules
    .filter((r) => r.id === ruleId && r.effectiveFrom <= periodStart && (!r.effectiveTo || periodStart <= r.effectiveTo))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

export type ScheduleInput = {
  pack: RulePack; clients: ClientFacts[]; fy: number;
  extensions?: Extension[]; calendar?: HolidayCalendar;
};

export function schedule({ pack, clients, fy, extensions = [], calendar = holidayCalendar() }: ScheduleInput): DueItem[] {
  const out: DueItem[] = [];
  const ruleIds = [...new Set(pack.rules.map((r) => r.id))];
  for (const id of ruleIds) {
    const proto = pack.rules.find((r) => r.id === id)!;
    for (const period of periodsForFy(proto, fy)) {
      const rule = ruleInForce(pack, id, period.start);
      if (!rule) continue;
      const ov = rule.periodOverrides.find((o) => o.periodEndMonth === parse(period.end).m);
      const statutory = evalDue(ov?.due ?? rule.due, period);
      for (const c of clients) {
        if (!matches(rule.applicability, c)) continue;
        const ext = extensions.find((e) => e.ruleId === id && e.periodKey === period.key && matches(e.scope, c));
        const due = ext ? ext.newDueDate : statutory;
        out.push({
          clientId: c.id, ruleId: id, form: rule.form, period,
          statutoryDue: due, actBy: shift(due, rule.holidayShift, calendar), extensionId: ext?.id,
        });
      }
    }
  }
  return out;
}

export type DueChange = { clientId: string; ruleId: string; periodKey: string; from: string | null; to: string | null };

/** Diff two schedules — powers "23 due dates changed for 412 clients" approval screens. */
export function diffSchedules(before: DueItem[], after: DueItem[]) {
  const k = (i: DueItem) => `${i.clientId}|${i.ruleId}|${i.period.key}`;
  const a = new Map(before.map((i) => [k(i), i])); const b = new Map(after.map((i) => [k(i), i]));
  const changes: DueChange[] = [];
  for (const [key, x] of a) {
    const y = b.get(key);
    if (!y || y.statutoryDue !== x.statutoryDue) changes.push({ clientId: x.clientId, ruleId: x.ruleId, periodKey: x.period.key, from: x.statutoryDue, to: y?.statutoryDue ?? null });
  }
  for (const [key, y] of b) if (!a.has(key)) changes.push({ clientId: y.clientId, ruleId: y.ruleId, periodKey: y.period.key, from: null, to: y.statutoryDue });
  const dueDates = new Set(changes.map((c) => `${c.ruleId}|${c.periodKey}`)).size;
  return { changes, dueDatesChanged: dueDates, clientsAffected: new Set(changes.map((c) => c.clientId)).size };
}
