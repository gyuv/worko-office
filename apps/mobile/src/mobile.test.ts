import { contrast } from '@worko/ui-tokens';
import { describe, expect, it } from 'vitest';
import { TABS } from './nav';
import { CHANNELS, channelFor } from './channels';
import { CATEGORIES } from '@worko/notify';
import { themeFor } from './theme';

describe('mobile shell', () => {
  it('has the five bottom tabs from the spec, in order', () => {
    expect(TABS.map((x) => x.key)).toEqual(['home', 'tasks', 'clients', 'inbox', 'more']);
  });
  it('follows the system colour scheme with accessible contrast', () => {
    for (const scheme of ['light', 'dark', null] as const) {
      const th = themeFor(scheme);
      expect(th.name).toBe(scheme === 'dark' ? 'dark' : 'light');
      expect(contrast(th.text, th.bg)).toBeGreaterThan(4.5);
      expect(contrast(th.status.overdue, th.surface)).toBeGreaterThan(4.5);
    }
  });
});

describe('android notification channels', () => {
  it('every category maps to a defined channel; critical always to the critical channel', () => {
    const ids = new Set(CHANNELS.map((c) => c.id));
    for (const c of CATEGORIES) expect(ids.has(channelFor(c, 'normal'))).toBe(true);
    expect(channelFor('task.commented', 'critical')).toBe('critical');
    expect(channelFor('notice.hearing', 'high')).toBe('compliance');
    expect(channelFor('invoice.due', 'normal')).toBe('billing');
  });
});
