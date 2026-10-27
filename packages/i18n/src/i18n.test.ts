import { describe, expect, it } from 'vitest';
import { createTranslator, formatDate, formatNumber, registerLocale } from './index.js';

describe('i18n', () => {
  it('interpolates, with defaults', () => {
    const t = createTranslator('en-IN', { product: 'Worko' });
    expect(t('app.name')).toBe('Worko');
    expect(t('audit.intact', { count: 12 })).toBe('Chain intact — 12 entries checked');
  });
  it('falls back to English for missing keys', () => {
    registerLocale('hi-IN', { 'common.save': 'सहेजें' });
    const t = createTranslator('hi-IN');
    expect(t('common.save')).toBe('सहेजें');
    expect(t('common.cancel')).toBe('Cancel');
  });
  it('formats in IST with Indian grouping', () => {
    expect(formatDate('2026-03-31T20:00:00Z')).toBe('01 Apr 2026'); // 01:30 IST next day
    expect(formatNumber(12345678)).toBe('1,23,45,678');
  });
});
