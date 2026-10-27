import { create } from 'zustand';

/** Tiny hash router: routes are flat module pages; deep links look like #/security. */
export const ROUTES = ['home', 'tasks', 'clients', 'compliance', 'billing', 'documents', 'reports', 'team', 'security', 'audit'] as const;
export type Route = (typeof ROUTES)[number];

const parse = (): Route => {
  const r = (typeof location !== 'undefined' ? location.hash.replace(/^#\/?/, '') : '') as Route;
  return ROUTES.includes(r) ? r : 'home';
};

export const useRoute = create<{ route: Route; go(r: Route): void }>((set) => ({
  route: parse(),
  go(r) { if (location.hash !== `#/${r}`) location.hash = `/${r}`; set({ route: r }); },
}));
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => useRoute.setState({ route: parse() }));
