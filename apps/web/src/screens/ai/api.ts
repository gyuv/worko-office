import { useQuery } from '@tanstack/react-query';
import type { AiFeature } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api } from '../../lib/session';
import { as, asFull, body } from '../leads/api';
import { aiButtonVisible, type AiAvailability, type AiSettingsView, type Suggestion } from './logic';

export { as, asFull, body };
export type Usage = { month: string; provider: string; totalPaise: number; capPaise: number;
  byFeature: Array<{ key: string; inputTokens: number; outputTokens: number; costPaise: number; calls: number }>;
  byUser: Array<{ key: string | null; inputTokens: number; outputTokens: number; costPaise: number; calls: number }>;
  byRule: Array<{ key: string; inputTokens: number; outputTokens: number; costPaise: number; calls: number }> };

/** AI settings — Settings → AI screen only (needs settings:view). */
export function useAiSettings() {
  const can = useCan();
  return useQuery({ queryKey: ['ai', 'settings'], enabled: can('settings', 'view'), retry: false, staleTime: 60_000,
    queryFn: () => as<AiSettingsView>(api.GET('/ai/settings')) });
}
export const useAiUsage = (month: string) => useQuery({ queryKey: ['ai', 'usage', month], queryFn: () => as<Usage>(api.GET('/ai/usage', { params: { query: { month } } } as never)) });
export const useSuggestions = (q: { status?: string; clientId?: string }) => useQuery({
  queryKey: ['ai', 'suggestions', q.status ?? '', q.clientId ?? ''],
  queryFn: () => as<{ items: Suggestion[] }>(api.GET('/ai/suggestions', { params: { query: { ...(q.status ? { status: q.status } : {}), ...(q.clientId ? { clientId: q.clientId } : {}) } } } as never)).then((r) => r.items),
});

/** Effective per-feature gate for AI buttons (ai:view; no settings detail). */
export function useAiAvailability() {
  const can = useCan();
  return useQuery({ queryKey: ['ai', 'availability'], enabled: can('ai', 'view'), retry: false, staleTime: 60_000,
    queryFn: () => as<AiAvailability>(api.GET('/ai/availability')) });
}
/** True when an in-context AI button for `feature` should render. */
export function useAiFeature(feature: AiFeature): boolean {
  const can = useCan();
  const a = useAiAvailability().data;
  return aiButtonVisible({ canCreate: can('ai', 'create'), availability: a, feature });
}

export function useAiError() {
  const t = useT();
  return (e: unknown) => {
    const x = e as { code?: string; message?: string; status?: number };
    if (x.code) { const k = `p10.aerr.${x.code}` as MessageKey; const s = t(k); if (s !== k) return s; }
    return x.message ?? t('common.error');
  };
}
