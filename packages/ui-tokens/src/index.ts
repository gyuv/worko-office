/**
 * Design tokens shared by web, Electron and React Native. Colours are tuned for WCAG AA text contrast
 * on their surface in both themes. Status semantics are fixed product-wide (spec §13) and always paired
 * with an icon so they never rely on colour alone.
 */
export type ThemeName = 'light' | 'dark';

export const palette = {
  light: {
    bg: '#f3f5f3', surface: '#ffffff', surfaceAlt: '#eef3ef', border: '#e2e8e3',
    text: '#0d1410', textMuted: '#3f4943', primary: '#166534', primaryText: '#ffffff', focus: '#166534',
    primarySoft: '#dcf3e3', primaryStrong: '#0b3d22', accent: '#22a35a',
  },
  dark: {
    bg: '#0e1210', surface: '#151b17', surfaceAlt: '#1c241f', border: '#29332c',
    text: '#f1f5f2', textMuted: '#b9c6be', primary: '#4ade80', primaryText: '#052e16', focus: '#4ade80',
    primarySoft: '#173a25', primaryStrong: '#0b2a18', accent: '#34d399',
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
export const radius = { sm: 4, md: 8, lg: 12, xl: 20 } as const;
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

/** Client-portal white-label accents: a fixed subset firms choose from (keys = PORTAL_ACCENTS in @worko/domain). AA on white / dark surface. */
export const portalAccents = {
  blue: { light: '#1f4fd1', dark: '#7aa2ff' },
  teal: { light: '#0f766e', dark: '#5eead4' },
  green: { light: '#15803d', dark: '#86efac' },
  indigo: { light: '#4338ca', dark: '#a5b4fc' },
  maroon: { light: '#9f1239', dark: '#fda4af' },
  slate: { light: '#334155', dark: '#cbd5e1' },
} as const;
export type PortalAccent = keyof typeof portalAccents;

/**
 * User-selectable accent schemes. Each overrides the primary family for both themes; button text (primaryText) on
 * primary and on gradB meets AA, and primary itself reads as text on the surface.
 */
type AccentSet = { primary: string; primaryText: string; primarySoft: string; primaryStrong: string; accent: string; gradB: string; heroA: string; heroB: string; blobA: string; blobB: string };
export const accents: Record<string, { label: string; light: AccentSet; dark: AccentSet }> = {
  green: { label: 'Green', light: { primary: '#166534', primaryText: '#ffffff', primarySoft: '#dcf3e3', primaryStrong: '#0b3d22', accent: '#22a35a', gradB: '#15803d', heroA: '#0b3d22', heroB: '#166534', blobA: '34,163,90', blobB: '20,184,166' },
    dark: { primary: '#4ade80', primaryText: '#052e16', primarySoft: '#173a25', primaryStrong: '#0b2a18', accent: '#34d399', gradB: '#22c55e', heroA: '#0b2a18', heroB: '#166534', blobA: '34,197,94', blobB: '20,184,166' } },
  blue: { label: 'Blue', light: { primary: '#1d4ed8', primaryText: '#ffffff', primarySoft: '#dbe7fe', primaryStrong: '#172f73', accent: '#3b82f6', gradB: '#2563eb', heroA: '#172f73', heroB: '#1d4ed8', blobA: '59,130,246', blobB: '14,165,233' },
    dark: { primary: '#7aa2ff', primaryText: '#0b1020', primarySoft: '#1b2747', primaryStrong: '#101a36', accent: '#60a5fa', gradB: '#93b4ff', heroA: '#101a36', heroB: '#1d4ed8', blobA: '59,130,246', blobB: '14,165,233' } },
  teal: { label: 'Teal', light: { primary: '#0f766e', primaryText: '#ffffff', primarySoft: '#d5f2ee', primaryStrong: '#083f3b', accent: '#14b8a6', gradB: '#0d6b64', heroA: '#083f3b', heroB: '#0f766e', blobA: '20,184,166', blobB: '34,197,94' },
    dark: { primary: '#5eead4', primaryText: '#042f2b', primarySoft: '#123a36', primaryStrong: '#082a27', accent: '#2dd4bf', gradB: '#2dd4bf', heroA: '#082a27', heroB: '#0f766e', blobA: '20,184,166', blobB: '34,197,94' } },
  indigo: { label: 'Indigo', light: { primary: '#4338ca', primaryText: '#ffffff', primarySoft: '#e3e1fb', primaryStrong: '#262073', accent: '#6366f1', gradB: '#4f46e5', heroA: '#262073', heroB: '#4338ca', blobA: '99,102,241', blobB: '168,85,247' },
    dark: { primary: '#a5b4fc', primaryText: '#1e1b4b', primarySoft: '#25234f', primaryStrong: '#17153a', accent: '#818cf8', gradB: '#818cf8', heroA: '#17153a', heroB: '#4338ca', blobA: '99,102,241', blobB: '168,85,247' } },
  violet: { label: 'Violet', light: { primary: '#6d28d9', primaryText: '#ffffff', primarySoft: '#ece2fd', primaryStrong: '#3b1578', accent: '#8b5cf6', gradB: '#7c3aed', heroA: '#3b1578', heroB: '#6d28d9', blobA: '139,92,246', blobB: '236,72,153' },
    dark: { primary: '#c4b5fd', primaryText: '#2e1065', primarySoft: '#2d2050', primaryStrong: '#1e123d', accent: '#a78bfa', gradB: '#a78bfa', heroA: '#1e123d', heroB: '#6d28d9', blobA: '139,92,246', blobB: '236,72,153' } },
  rose: { label: 'Rose', light: { primary: '#be123c', primaryText: '#ffffff', primarySoft: '#fde2e7', primaryStrong: '#6b0a22', accent: '#f43f5e', gradB: '#9f1239', heroA: '#6b0a22', heroB: '#be123c', blobA: '244,63,94', blobB: '249,115,22' },
    dark: { primary: '#fda4af', primaryText: '#4c0519', primarySoft: '#47202a', primaryStrong: '#33101a', accent: '#fb7185', gradB: '#fb7185', heroA: '#33101a', heroB: '#9f1239', blobA: '244,63,94', blobB: '249,115,22' } },
  amber: { label: 'Amber', light: { primary: '#92400e', primaryText: '#ffffff', primarySoft: '#fdecd2', primaryStrong: '#4f2307', accent: '#d97706', gradB: '#a14a0c', heroA: '#4f2307', heroB: '#92400e', blobA: '245,158,11', blobB: '234,88,12' },
    dark: { primary: '#fcd34d', primaryText: '#3b2204', primarySoft: '#3f3015', primaryStrong: '#2c1f08', accent: '#fbbf24', gradB: '#fbbf24', heroA: '#2c1f08', heroB: '#92400e', blobA: '245,158,11', blobB: '234,88,12' } },
  slate: { label: 'Slate', light: { primary: '#334155', primaryText: '#ffffff', primarySoft: '#e2e8f0', primaryStrong: '#141c28', accent: '#64748b', gradB: '#3f4d63', heroA: '#141c28', heroB: '#334155', blobA: '100,116,139', blobB: '56,189,248' },
    dark: { primary: '#cbd5e1', primaryText: '#0f172a', primarySoft: '#262f3d', primaryStrong: '#141a24', accent: '#94a3b8', gradB: '#94a3b8', heroA: '#141a24', heroB: '#334155', blobA: '100,116,139', blobB: '56,189,248' } },
};
export type AccentName = keyof typeof accents;

/** CSS for every accent: `:root[data-accent=x]` (light) and the dark variants (data-theme=dark or system dark). */
export function accentCss(): string {
  const vars = (a: AccentSet) => [
    `--w-primary:${a.primary}`, `--w-focus:${a.primary}`, `--w-primary-text:${a.primaryText}`, `--w-primary-soft:${a.primarySoft}`, `--w-primary-strong:${a.primaryStrong}`,
    `--w-accent:${a.accent}`, `--btn-grad-a:${a.primary}`, `--btn-grad-b:${a.gradB}`, `--hero-a:${a.heroA}`, `--hero-b:${a.heroB}`,
    `--blob-a:rgba(${a.blobA},.38)`, `--blob-b:rgba(${a.blobB},.3)`,
  ].join(';');
  return Object.entries(accents).map(([k, a]) => [
    `:root[data-accent=${k}]{${vars(a.light)}}`,
    `:root[data-accent=${k}][data-theme=dark]{${vars(a.dark)}}`,
    `@media (prefers-color-scheme: dark){:root[data-accent=${k}]:not([data-theme=light]){${vars(a.dark)}}}`,
  ].join('\n')).join('\n');
}
