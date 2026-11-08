import { accentCss, type AccentName } from '@worko/ui-tokens';
import { create } from 'zustand';
import { api } from './session';
import { useTheme, type ThemePref } from './theme';

export type UiPrefs = {
  theme?: ThemePref; accent?: AccentName; fontScale?: 'sm' | 'md' | 'lg' | 'xl'; density?: 'comfortable' | 'compact';
  motion?: 'full' | 'reduced'; glass?: boolean; hiddenModules?: string[]; sidebar?: 'expanded' | 'compact';
};
export const DEFAULT_PREFS: Required<UiPrefs> = { theme: 'system', accent: 'green', fontScale: 'md', density: 'comfortable', motion: 'full', glass: true, hiddenModules: [], sidebar: 'expanded' };

const KEY = 'worko.uiPrefs';
const read = (): UiPrefs => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as UiPrefs; } catch { return {}; } };
const write = (p: UiPrefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } };

function injectAccents() {
  if (typeof document === 'undefined' || document.getElementById('worko-accents')) return;
  const s = document.createElement('style'); s.id = 'worko-accents'; s.textContent = accentCss(); document.head.appendChild(s);
}

/** Puts the preferences on <html> as data attributes; index.css and the accent CSS do the rest. */
export function applyPrefs(p: UiPrefs) {
  if (typeof document === 'undefined') return;
  injectAccents();
  const full = { ...DEFAULT_PREFS, ...p };
  const el = document.documentElement;
  el.dataset.accent = full.accent; el.dataset.scale = full.fontScale; el.dataset.density = full.density;
  el.dataset.motion = full.motion; el.dataset.glass = full.glass ? 'on' : 'off'; el.dataset.sidebar = full.sidebar;
  if (useTheme.getState().pref !== full.theme) useTheme.getState().set(full.theme);
}

/**
 * Per-user display preferences. Stored on the server (they follow the user to every device) and cached locally so
 * the first paint already uses them.
 */
export const usePrefs = create<{ prefs: UiPrefs; loaded: boolean; load(): Promise<void>; update(patch: UiPrefs): Promise<void>; reset(): Promise<void> }>((set, get) => ({
  prefs: read(),
  loaded: false,
  async load() {
    try {
      const r = await api.GET('/me/ui-prefs');
      if (r.data) { const p = r.data as UiPrefs; write(p); applyPrefs(p); set({ prefs: p, loaded: true }); return; }
    } catch { /* offline: keep the cached copy */ }
    set({ loaded: true });
  },
  async update(patch) {
    const next = { ...get().prefs, ...patch };
    set({ prefs: next }); write(next); applyPrefs(next);
    try { await api.PUT('/me/ui-prefs', { body: next as never }); } catch { /* retried with the next change */ }
  },
  async reset() { set({ prefs: {} }); write({}); applyPrefs({}); try { await api.PUT('/me/ui-prefs', { body: {} as never }); } catch { /* offline */ } },
}));

export const initPrefs = () => applyPrefs(read());
