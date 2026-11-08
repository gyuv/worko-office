import { palette, status, type ThemeName } from '@worko/ui-tokens';

export type Theme = (typeof palette)[ThemeName] & {
  name: ThemeName; status: Record<keyof typeof status, string>;
  /** Glass: translucent surface + hairline light border, shown over the moving colour backdrop. */
  glass: string; glassBorder: string;
};

/** '#rrggbb' + alpha → 'rgba(r,g,b,a)'. */
export const alpha = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

export function themeFor(scheme: 'light' | 'dark' | null | undefined): Theme {
  const name: ThemeName = scheme === 'dark' ? 'dark' : 'light';
  const s = Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v[name]])) as Theme['status'];
  const p = palette[name];
  return { ...p, name, status: s, glass: alpha(p.surface, name === 'dark' ? 0.62 : 0.7), glassBorder: name === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)' };
}
