/**
 * Design tokens shared by web, Electron and React Native. Colours are tuned for WCAG AA text contrast
 * on their surface in both themes. Status semantics are fixed product-wide (spec §13) and always paired
 * with an icon so they never rely on colour alone.
 */
export type ThemeName = 'light' | 'dark';

export const palette = {
  light: {
    bg: '#f7f8fa', surface: '#ffffff', surfaceAlt: '#f1f3f6', border: '#dde1e7',
    text: '#14181f', textMuted: '#555e6c', primary: '#1f4fd1', primaryText: '#ffffff', focus: '#1f4fd1',
  },
  dark: {
    bg: '#0f1217', surface: '#161a21', surfaceAlt: '#1d222b', border: '#2b313c',
    text: '#e7eaf0', textMuted: '#9aa3b2', primary: '#7aa2ff', primaryText: '#0b1020', focus: '#7aa2ff',
  },
} as const;

export type Status = 'overdue' | 'dueSoon' | 'done' | 'waitingClient' | 'onHold' | 'inProgress' | 'notStarted';

/** icon = lucide icon name (web/desktop) and @expo/vector-icons Feather name (mobile) — same glyph set. */
export const status: Record<Status, { light: string; dark: string; icon: string; labelKey: string }> = {
  overdue: { light: '#c62828', dark: '#ff6b6b', icon: 'alert-octagon', labelKey: 'status.overdue' },
  dueSoon: { light: '#a65c00', dark: '#ffb547', icon: 'clock', labelKey: 'status.dueSoon' },
  done: { light: '#1b7a3a', dark: '#4cd17f', icon: 'check-circle', labelKey: 'status.done' },
  waitingClient: { light: '#1565c0', dark: '#64a8ff', icon: 'user-check', labelKey: 'status.waitingClient' },
  onHold: { light: '#5f6673', dark: '#a0a7b4', icon: 'pause-circle', labelKey: 'status.onHold' },
  inProgress: { light: '#6a3fc1', dark: '#b394ff', icon: 'loader', labelKey: 'status.inProgress' },
  notStarted: { light: '#5f6673', dark: '#a0a7b4', icon: 'circle', labelKey: 'status.notStarted' },
};

export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;
export const radius = { sm: 4, md: 6, lg: 10 } as const;
export const font = {
  family: "Inter, 'Segoe UI', system-ui, -apple-system, 'Noto Sans', 'Noto Sans Devanagari', 'Noto Sans Tamil', sans-serif",
  mono: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  size: { xs: 11, sm: 12, md: 13, lg: 15, xl: 18, xxl: 22 },
} as const;
/** Dense = default for desktop tables; comfortable for touch. */
export const density = { compact: { rowHeight: 28 }, comfortable: { rowHeight: 40 } } as const;

/** CSS custom properties for a theme, e.g. injected into :root[data-theme=dark]. */
export function cssVariables(theme: ThemeName): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(palette[theme])) vars[`--w-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = v;
  for (const [k, v] of Object.entries(status)) vars[`--w-status-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = v[theme];
  return vars;
}

export function cssText(): string {
  const block = (sel: string, t: ThemeName) => `${sel}{${Object.entries(cssVariables(t)).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  return [block(':root,[data-theme=light]', 'light'), block('[data-theme=dark]', 'dark'),
    `@media (prefers-color-scheme: dark){:root:not([data-theme=light]){${Object.entries(cssVariables('dark')).map(([k, v]) => `${k}:${v}`).join(';')}}}`].join('\n');
}

/** WCAG relative-luminance contrast ratio — used by tests to keep the palette accessible. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
