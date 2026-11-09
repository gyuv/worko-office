import { describe, expect, it } from 'vitest';
import { parseQuickTask } from './quick.js';

// 2026-11-09 is a Monday.
const today = '2026-11-09';
const people = [{ id: 'u1', name: 'Ravi Kumar' }, { id: 'u2', name: 'Priya S' }];
const me = { id: 'u0', name: 'Anna' };
const p = (s: string) => parseQuickTask(s, { today, people, me });

describe('parseQuickTask', () => {
  it('keeps plain text as the title', () => {
    expect(p('Prepare GST return')).toMatchObject({ title: 'Prepare GST return', actBy: null, priority: 'normal', assignee: null, clientQuery: null });
  });
  it('reads relative dates', () => {
    expect(p('call bank today').actBy).toBe('2026-11-09');
    expect(p('call bank tomorrow').actBy).toBe('2026-11-10');
    expect(p('call bank by friday').actBy).toBe('2026-11-13');
    expect(p('call bank mon').actBy).toBe('2026-11-16');
    expect(p('call bank next week').actBy).toBe('2026-11-16');
    expect(p('call bank in 3 days').actBy).toBe('2026-11-12');
    expect(p('call bank in 2 weeks').actBy).toBe('2026-11-23');
    expect(p('call bank tomorrow').title).toBe('call bank');
  });
  it('reads day-month dates and rolls past ones into next year', () => {
    expect(p('TDS 15/11').actBy).toBe('2026-11-15');
    expect(p('TDS 20 dec').actBy).toBe('2026-12-20');
    expect(p('TDS jan 5').actBy).toBe('2027-01-05');
    expect(p('TDS 1/1').actBy).toBe('2027-01-01');
    expect(p('TDS 31/2').actBy).toBeNull();
  });
  it('reads priority, people and client tokens', () => {
    const r = p('Audit file #acme-traders !! @ravi tomorrow');
    expect(r).toMatchObject({ title: 'Audit file', priority: 'high', assignee: { id: 'u1' }, clientQuery: 'acme traders', actBy: '2026-11-10' });
    expect(r.tokens.map((x) => x.kind)).toEqual(['client', 'priority', 'person', 'date']);
    expect(p('x !urgent').priority).toBe('urgent');
    expect(p('x @me').assignee).toEqual(me);
    expect(p('email @nobody').title).toBe('email @nobody');
  });
  it('only takes the first date', () => {
    expect(p('move 10 dec meeting to tomorrow')).toMatchObject({ actBy: '2026-12-10', title: 'move meeting to tomorrow' });
  });
});
