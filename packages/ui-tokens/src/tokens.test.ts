import { describe, expect, it } from 'vitest';
import { accentCss, accents, contrast, cssText, cssVariables, palette, portalAccents, status } from './index.js';

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
  it('portal accents meet AA on surface in both themes', () => {
    expect(Object.keys(portalAccents)).toEqual(['blue', 'teal', 'green', 'indigo', 'maroon', 'slate']);
    for (const a of Object.values(portalAccents)) for (const t of ['light', 'dark'] as const) expect(contrast(a[t], palette[t].surface)).toBeGreaterThan(4.5);
  });
  it('every user accent keeps button text and links readable (AA) in both themes', () => {
    for (const [name, a] of Object.entries(accents)) for (const t of ['light', 'dark'] as const) {
      const x = a[t];
      expect(contrast(x.primaryText, x.primary), `${name}/${t} text on primary`).toBeGreaterThan(4.5);
      expect(contrast(x.primaryText, x.gradB), `${name}/${t} text on gradient end`).toBeGreaterThan(4.5);
      expect(contrast('#ffffff', x.heroA), `${name}/${t} hero start`).toBeGreaterThan(4.5);
      expect(contrast('#ffffff', x.heroB), `${name}/${t} hero end`).toBeGreaterThan(4.5);
      expect(contrast(x.primary, palette[t].surface), `${name}/${t} primary as text`).toBeGreaterThan(4.5);
    }
    expect(accentCss()).toContain(':root[data-accent=indigo]');
  });
});
