import type { Schemas } from '@worko/api-client';

export type Matrix = Schemas['ComplianceMatrix'];
export type Cell = Matrix['cells'][number];
export type CellTone = 'done' | 'overdue' | 'dueSoon' | 'open' | 'notCreated' | 'missing';

const DUE_SOON_DAYS = 7;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Display tone of a matrix cell. Server states: not_created | open | done | overdue.
 * A not-created item whose statutory due has passed is "missing" (worse than merely not created);
 * an open item due within a week is "due soon".
 */
export function cellTone(c: Pick<Cell, 'state' | 'statutoryDue'>, asOf: string): CellTone {
  switch (c.state) {
    case 'done': return 'done';
    case 'overdue': return 'overdue';
    case 'open': return days(asOf, c.statutoryDue) <= DUE_SOON_DAYS ? 'dueSoon' : 'open';
    default: return c.statutoryDue < asOf ? 'missing' : 'notCreated';
  }
}

/** Tailwind classes per tone; colours come from ui-tokens via the tailwind theme. */
export const TONE_CLASS: Record<CellTone, string> = {
  done: 'bg-done text-primary-fg',
  overdue: 'bg-overdue text-primary-fg',
  dueSoon: 'bg-due-soon text-primary-fg',
  open: 'bg-primary text-primary-fg',
  notCreated: 'border border-dashed border-border text-muted',
  missing: 'border-2 border-dashed border-overdue text-overdue',
};

export type Column = { ruleId: string; periodKey: string; label: string; form: string; statutoryDue: string };

/** Columns = rule × period pairs present in the range (ordered by due date); rows keyed by client. */
export function buildMatrix(m: Matrix): { columns: Column[]; cell(clientId: string, col: Column): Cell | undefined } {
  const rules = new Map(m.rules.map((r) => [r.id ?? '', r]));
  const cols = new Map<string, Column>();
  const idx = new Map<string, Cell>();
  for (const c of m.cells) {
    const k = `${c.ruleId}|${c.periodKey}`;
    if (!cols.has(k)) cols.set(k, { ruleId: c.ruleId, periodKey: c.periodKey, label: c.periodLabel ?? c.periodKey, form: rules.get(c.ruleId)?.form ?? c.ruleId, statutoryDue: c.statutoryDue });
    idx.set(`${c.clientId}|${k}`, c);
  }
  const columns = [...cols.values()].sort((a, b) => a.statutoryDue.localeCompare(b.statutoryDue) || a.form.localeCompare(b.form));
  return { columns, cell: (clientId, col) => idx.get(`${clientId}|${col.ruleId}|${col.periodKey}`) };
}

/** Tally of tones, for the legend. */
export function toneCounts(m: Matrix): Record<CellTone, number> {
  const out: Record<CellTone, number> = { done: 0, overdue: 0, dueSoon: 0, open: 0, notCreated: 0, missing: 0 };
  for (const c of m.cells) out[cellTone(c, m.asOf)]++;
  return out;
}
