import { describe, expect, it } from 'vitest';
import { contrast, cssText, cssVariables, palette, status } from './index.js';

describe('tokens', () => {
  for (const t of ['light', 'dark'] as const) {
    it(`${t}: text and status colours meet WCAG AA (4.5:1) on surface`, () => {
      expect(contrast(palette[t].text, palette[t].surface)).toBeGreaterThan(4.5);
      expect(contrast(palette[t].textMuted, palette[t].surface)).toBeGreaterThan(4.5);
      expect(contrast(palette[t].primaryText, palette[t].primary)).toBeGreaterThan(4.5);
      for (const s of Object.values(status)) expect(contrast(s[t], palette[t].surface)).toBeGreaterThan(4.5);
    });
  }
  it('every status has an icon (colour-blind safe)', () => expect(Object.values(status).every((s) => s.icon)).toBe(true));
  it('emits css variables', () => {
    expect(cssVariables('dark')['--w-text-muted']).toBe(palette.dark.textMuted);
    expect(cssText()).toContain('[data-theme=dark]');
  });
});
