import { en, type MessageKey, type Messages } from './en.js';

export { en, type MessageKey, type Messages };
export type Locale = 'en-IN' | 'hi-IN' | 'ta-IN';
export type Vars = Record<string, string | number>;

const catalogs: Partial<Record<Locale, Partial<Messages>>> = { 'en-IN': en };

/** Register a translation catalogue (e.g. lazily loaded hi-IN). Missing keys fall back to English. */
export function registerLocale(locale: Locale, messages: Partial<Messages>) { catalogs[locale] = messages; }

export function createTranslator(locale: Locale = 'en-IN', defaults: Vars = {}) {
  const cat = catalogs[locale] ?? {};
  return (key: MessageKey, vars: Vars = {}): string => {
    const tpl = cat[key] ?? en[key] ?? key;
    const all = { ...defaults, ...vars };
    return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in all ? String(all[k]) : m));
  };
}
export type Translate = ReturnType<typeof createTranslator>;

/** Dates/times always shown in IST regardless of device zone; Indian digit grouping for numbers. */
export function formatDate(d: Date | string, locale: Locale = 'en-IN') {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(d));
}
export function formatDateTime(d: Date | string, locale: Locale = 'en-IN') {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(d));
}
export function formatNumber(n: number, locale: Locale = 'en-IN') { return new Intl.NumberFormat(locale).format(n); }

export function relativeTime(d: Date | string, now = Date.now(), locale: Locale = 'en-IN') {
  const s = Math.round((new Date(d).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
