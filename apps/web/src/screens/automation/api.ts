import { useQuery } from '@tanstack/react-query';
import type { AutomationSettings, RuleDefinition, RuleScope } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/session';
import { as, asFull, body } from '../leads/api';
import type { DryRun, RunAction } from './logic';

/** Typed views of the Phase 10 automation responses (apps/api/src/automation/*); the spec models them as plain objects. */
export { as, asFull, body };

export type Rule = {
  id: string; name: string; description: string | null; ownerId: string; scope: RuleScope; enabled: boolean; status: 'active' | 'paused'; pausedReason: string | null; pausedAt: string | null;
  definition: RuleDefinition; triggerEvent: string; version: number; agentKey: string | null; agentParams: Record<string, unknown> | null; consecutiveFailures: number;
  nextRunAt: string | null; lastRunAt: string | null; createdAt: string; updatedAt: string;
};
export type Agent = { key: string; name: string; description: string; defaults: Record<string, unknown>; definition: RuleDefinition };
export type Run = {
  id: string; ruleId: string; ruleName: string; ruleVersion: number; eventId: string | null; eventType: string | null; entityType: string | null; entityId: string | null;
  subjectKey: string | null; step: string | null; status: string; skipReason: string | null; depth: number; actionsTotal: number; actionsDone: number; costPaise: number;
  error: string | null; attempts: number; startedAt: string; finishedAt: string | null;
};
export type RunDetail = Run & { actions: RunAction[] };
export type Version = { version: number; name: string; definition: RuleDefinition; changedBy: string | null; changedAt: string; note: string | null };
export type Costs = { month: string; totalPaise: number; capPaise: number; items: Array<{ ruleId: string; name: string; commPaise: number; aiPaise: number; totalPaise: number; capPaise: number; actions: number }> };
export type { DryRun };

export const useRules = () => useQuery({ queryKey: ['automation', 'rules'], queryFn: () => as<{ items: Rule[] }>(api.GET('/automation/rules')).then((r) => r.items) });
export const useAgents = () => useQuery({ queryKey: ['automation', 'agents'], queryFn: () => as<{ items: Agent[] }>(api.GET('/automation/agents')).then((r) => r.items), staleTime: 300_000 });
export const useCosts = (month?: string) => useQuery({ queryKey: ['automation', 'costs', month ?? ''], queryFn: () => as<Costs>(api.GET('/automation/costs', { params: { query: month ? { month } : {} } } as never)) });
export const useAutomationSettings = () => useQuery({ queryKey: ['automation', 'settings'], queryFn: () => as<AutomationSettings>(api.GET('/automation/settings')) });

/** Friendly text for API errors (zod issues flattened). */
export function useAutoError() {
  const t = useT();
  return (e: unknown) => {
    const x = e as { code?: string; message?: string; status?: number; body?: { issues?: Array<{ path?: unknown[]; message: string }> } };
    const issues = x.body?.issues?.map((i) => `${(i.path ?? []).join('.')}: ${i.message}`).join('; ');
    if (x.code) { const k = `p10.err.${x.code}` as MessageKey; const s = t(k); if (s !== k) return issues ? `${s} (${issues})` : s; }
    if (x.status === 403) return t('p10.err.forbidden');
    return issues ? `${x.message ?? ''} ${issues}`.trim() : x.message ?? t('common.error');
  };
}
/** Label for a code with a fallback (events, actions, fields, reasons…). */
export function useAutoLabel() {
  const t = useT();
  return (family: string, v: string | null | undefined) => {
    if (!v) return '—';
    const k = `p10.${family}.${v}` as MessageKey; const s = t(k);
    return s === k ? v.replace(/[._]/g, ' ') : s;
  };
}
