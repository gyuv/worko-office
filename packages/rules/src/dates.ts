/** Pure calendar arithmetic on ISO dates (no time zones; all dates are IST calendar days). */
export type YMD = { y: number; m: number; d: number };
export const parse = (s: string): YMD => { const [y, m, d] = s.split('-').map(Number) as [number, number, number]; return { y, m, d }; };
export const fmt = ({ y, m, d }: YMD) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const t = y * 12 + (m - 1) + n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}
export function addDays(s: string, n: number): string {
  const { y, m, d } = parse(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return fmt({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}
export const weekday = (s: string) => { const { y, m, d } = parse(s); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
export const lastDay = (y: number, m: number) => fmt({ y, m, d: daysInMonth(y, m) });
