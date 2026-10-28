import { describe, expect, it } from 'vitest';
import { buildMatrix, cellTone, toneCounts, type Matrix } from './logic';

const AS_OF = '2026-10-28';
describe('matrix cell status', () => {
  it('maps server states to tones', () => {
    expect(cellTone({ state: 'done', statutoryDue: '2026-10-11' }, AS_OF)).toBe('done');
    expect(cellTone({ state: 'overdue', statutoryDue: '2026-10-20' }, AS_OF)).toBe('overdue');
    expect(cellTone({ state: 'open', statutoryDue: '2026-11-03' }, AS_OF)).toBe('dueSoon');
    expect(cellTone({ state: 'open', statutoryDue: '2026-11-20' }, AS_OF)).toBe('open');
    expect(cellTone({ state: 'not_created', statutoryDue: '2026-11-20' }, AS_OF)).toBe('notCreated');
    expect(cellTone({ state: 'not_created', statutoryDue: '2026-10-20' }, AS_OF)).toBe('missing');
  });
  it('builds rule × period columns ordered by due date and indexes cells', () => {
    const m: Matrix = {
      from: '2026-10-01', to: '2026-11-30', asOf: AS_OF,
      rules: [{ id: 'gst.gstr3b', form: 'GSTR-3B' }, { id: 'gst.gstr1', form: 'GSTR-1' }],
      clients: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }],
      cells: [
        { clientId: 'c1', ruleId: 'gst.gstr3b', periodKey: '2026-09', periodLabel: 'Sep 2026', statutoryDue: '2026-10-20', state: 'overdue' },
        { clientId: 'c2', ruleId: 'gst.gstr1', periodKey: '2026-09', periodLabel: 'Sep 2026', statutoryDue: '2026-10-11', state: 'done' },
        { clientId: 'c1', ruleId: 'gst.gstr1', periodKey: '2026-10', periodLabel: 'Oct 2026', statutoryDue: '2026-11-11', state: 'not_created' },
      ],
    };
    const b = buildMatrix(m);
    expect(b.columns.map((c) => `${c.form} ${c.label}`)).toEqual(['GSTR-1 Sep 2026', 'GSTR-3B Sep 2026', 'GSTR-1 Oct 2026']);
    expect(b.cell('c1', b.columns[0]!)).toBeUndefined();
    expect(b.cell('c2', b.columns[0]!)?.state).toBe('done');
    expect(toneCounts(m)).toMatchObject({ done: 1, overdue: 1, notCreated: 1, missing: 0 });
  });
});
