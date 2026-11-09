import { useQuery } from '@tanstack/react-query';
import type { Action, Module } from '@worko/domain';
import { api, unwrap } from './session';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')), staleTime: 60_000 });

/** UI-level permission hint (hide what you can't use). The server always re-checks. */
export function useCan() {
  const me = useMe().data;
  return (module: Module, action: Action) => !!me?.grants.some((g) => g.module === module && g.action === action && g.scope !== 'none');
}

export type FeatureKey = 'portal' | 'automation' | 'ai' | 'payments' | 'whatsapp' | 'esign' | 'leads' | 'reports';
export type IntegrationKey = 'ai' | 'payments' | 'email' | 'sms' | 'whatsapp' | 'messaging' | 'esign' | 'portal' | 'calendarSync' | 'noticeExtraction' | 'gstinLookup';

/** Is a switchable module on for this firm (plan, platform overrides and server connections)? Unknown = on. */
export function useFeature() {
  const me = useMe().data as { features?: Record<string, boolean> } | undefined;
  return (f: FeatureKey) => me?.features?.[f] !== false;
}

/** Is this server connected to the outside service a button needs? Hidden until it is. Unknown = on. */
export function useIntegration() {
  const me = useMe().data as { integrations?: Record<string, boolean> } | undefined;
  return (k: IntegrationKey) => me?.integrations?.[k] !== false;
}
