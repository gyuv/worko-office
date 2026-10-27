import { cssText } from '@worko/ui-tokens';
import { create } from 'zustand';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'worko.theme';

export function injectTokens() {
  if (document.getElementById('worko-tokens')) return;
  const s = document.createElement('style');
  s.id = 'worko-tokens';
  s.textContent = cssText();
  document.head.appendChild(s);
}

function apply(p: ThemePref) {
  if (p === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', p);
}

export const useTheme = create<{ pref: ThemePref; set(p: ThemePref): void; toggle(): void }>((set, get) => ({
  pref: ((): ThemePref => { try { return (localStorage.getItem(KEY) as ThemePref) ?? 'system'; } catch { return 'system'; } })(),
  set(p) { apply(p); try { localStorage.setItem(KEY, p); } catch { /* private mode */ } set({ pref: p }); },
  toggle() {
    const dark = get().pref === 'dark' || (get().pref === 'system' && matchMedia?.('(prefers-color-scheme: dark)').matches);
    get().set(dark ? 'light' : 'dark');
  },
}));

export const initTheme = () => { injectTokens(); apply(useTheme.getState().pref); };
