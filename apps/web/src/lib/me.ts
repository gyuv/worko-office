import { useQuery } from '@tanstack/react-query';
import type { Action, Module } from '@worko/domain';
import { api, unwrap } from './session';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')), staleTime: 60_000 });

/** UI-level permission hint (hide what you can't use). The server always re-checks. */
export function useCan() {
  const me = useMe().data;
  return (module: Module, action: Action) => !!me?.grants.some((g) => g.module === module && g.action === action && g.scope !== 'none');
}
