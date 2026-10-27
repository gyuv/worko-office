import { palette, status, type ThemeName } from '@worko/ui-tokens';

export type Theme = (typeof palette)[ThemeName] & { name: ThemeName; status: Record<keyof typeof status, string> };

export function themeFor(scheme: 'light' | 'dark' | null | undefined): Theme {
  const name: ThemeName = scheme === 'dark' ? 'dark' : 'light';
  const s = Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v[name]])) as Theme['status'];
  return { ...palette[name], name, status: s };
}
