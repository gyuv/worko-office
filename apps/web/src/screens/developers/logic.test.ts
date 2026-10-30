import { describe, expect, it } from 'vitest';
import { deliveryTone, expiryIso, groupScopes, parseCidrs } from './logic';

describe('developers logic', () => {
  it('groups scopes by module in matrix order', () => {
    const g = groupScopes(['tasks:view', 'clients:create', 'clients:view']);
    expect(g.find((x) => x.module === 'clients')).toEqual({ module: 'clients', actions: ['create', 'view'] });
    expect(g.map((x) => x.module).sort()).toEqual(['clients', 'tasks']);
    expect(groupScopes(['bogus', 'clients:view'])).toEqual([{ module: 'clients', actions: ['view'] }]);
  });
  it('parses CIDR allow-lists', () => {
    expect(parseCidrs('203.0.113.0/24, 10.0.0.1\n bad/99')).toEqual({ cidrs: ['203.0.113.0/24', '10.0.0.1'], invalid: ['bad/99'] });
  });
  it('expiry and tones', () => {
    expect(expiryIso('2026-12-31T18:00')).toBe('2026-12-31T18:00:00+05:30');
    expect(expiryIso('')).toBeNull();
    expect(deliveryTone('failed')).toBe('text-overdue');
  });
});
