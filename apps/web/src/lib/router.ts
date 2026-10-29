import { create } from 'zustand';

/**
 * Tiny hash router. Top-level modules are flat (`#/security`); some modules take sub-paths
 * (`#/clients/<uuid>`, `#/clients/import`). `route` is always the module; `params` the remaining segments.
 */
export const ROUTES = ['home', 'tasks', 'clients', 'compliance', 'billing', 'receipts', 'documents', 'registers', 'time', 'attendance', 'leave', 'expenses', 'reports', 'notifications', 'team', 'security', 'audit', 'todos', 'settings', 'comm', 'chat', 'calendar', 'booking', 'notices', 'engagements', 'dsc', 'licences', 'esign', 'leads'] as const;
export type Route = (typeof ROUTES)[number];
export type Location = { route: Route; params: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | undefined): s is string => !!s && UUID.test(s);

/** Parses a hash such as `#/clients/<id>` into a module route plus params; unknown routes fall back to home. */
export function parseHash(hash: string): Location {
  const [head, ...rest] = hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  const route = (ROUTES as readonly string[]).includes(head ?? '') ? (head as Route) : 'home';
  return { route, params: route === 'home' ? [] : rest };
}

/** Client 360 or import wizard, decided from `#/clients/...` params. */
export function clientsView(params: string[]): { view: 'list' } | { view: 'import' } | { view: 'detail'; id: string } {
  if (params[0] === 'import') return { view: 'import' };
  if (isUuid(params[0])) return { view: 'detail', id: params[0] };
  return { view: 'list' };
}

const current = (): Location => parseHash(typeof location !== 'undefined' ? location.hash : '');

export const useRoute = create<Location & { go(path: Route | `${Route}/${string}`): void }>((set) => ({
  ...current(),
  go(path) {
    if (location.hash !== `#/${path}`) location.hash = `/${path}`;
    set(parseHash(`#/${path}`));
  },
}));
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => useRoute.setState(current()));
