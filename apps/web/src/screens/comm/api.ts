import { useQuery } from '@tanstack/react-query';
import { en, type MessageKey } from '@worko/i18n';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/session';
import { as } from '../hr/api';
import type { Consent, TimelinePage } from './logic';

/**
 * Typed views of the Phase 7 responses. The OpenAPI spec models many comm bodies as plain objects, so these mirror
 * the API presenters in apps/api/src/comm/*; request bodies go through `body()` (never).
 */
export { as, body } from '../hr/api';

export const CHANNELS = ['email', 'whatsapp', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CATEGORIES = ['transactional', 'utility', 'marketing'] as const;

export type Template = {
  id: string; name: string; channel: Channel; category: (typeof CATEGORIES)[number]; language: string; subject: string | null; body: string; variables: string[];
  sensitive: boolean; status: 'draft' | 'submitted' | 'approved' | 'rejected'; providerRef: string | null; rejectionReason: string | null; dltTemplateId: string | null; version: number;
};
export type CommSettings = {
  consent: { transactionalRequiresOptIn: boolean; optOutBlocksTransactional: boolean };
  quietHours: { start: string; end: string; appliesTo: 'all' | 'marketing' } | null;
  caps: { monthlyPaise: Record<Channel, number | null>; perBroadcastPaise: number | null; mode: 'block' | 'warn' };
  broadcast: { approvalThreshold: number; batchSize: number; batchIntervalSeconds: number };
  chat: { editWindowMinutes: number; maxLength: number };
  appointments: { reminderMinutesBefore: number[] };
};
export type Rate = { channel: Channel; category: string; paise: number; effectiveFrom: string; effectiveTo: string | null; source: 'card' | 'firm'; verified: boolean; note: string | null };
export type Usage = { month: string; capMode: 'block' | 'warn'; totalPaise: number; byChannel: Array<{ channel: Channel; messages: number; costPaise: number; capPaise: number | null; remainingPaise: number | null; overCap: boolean; capWarnings: number }> };
export type InboxItem = { id: string; channel: Channel; address: string; subject: string | null; body: string; triage: string | null; occurredAt: string };
export type BroadcastFilters = { groupIds?: string[]; tags?: string[]; serviceTypeIds?: string[]; entityTypes?: string[]; clientIds?: string[]; includeInactive?: boolean };
export type Broadcast = {
  id: string; name: string; channel: Channel; templateId: string; category: string; filters: BroadcastFilters; variables: Record<string, string> | null; scheduledAt: string | null;
  status: 'draft' | 'pending_approval' | 'approved' | 'scheduled' | 'sending' | 'completed' | 'cancelled'; estimate: Record<string, number | boolean> | null;
  approvedBy: string | null; approvedAt: string | null; cancelledAt: string | null; completedAt: string | null; spentPaise: number; createdBy: string; createdAt: string;
  progress?: { total: number; done: number; counts: Record<string, number> };
};
export type Recipient = { id: string; clientId: string; clientName: string; address: string | null; status: string; error: string | null; costPaise: number; sentAt: string | null; attempts: number };
export type Connection = { id: string; provider: 'mock' | 'google' | 'microsoft'; purpose: 'mail' | 'calendar'; status: string; accountEmail?: string | null; lastSyncAt?: string | null; lastError?: string | null; createdAt?: string };
export type Feed = { id: string; label: string | null; maskClients: boolean; createdAt: string; revokedAt: string | null; lastUsedAt: string | null };
export type BookingPage = { id: string; slug: string; title: string; description: string | null; hostUserIds: string[]; slotMinutes: number; bufferMinutes: number;
  workingHours: Record<string, Array<[string, string]>>; horizonDays: number; minNoticeMinutes: number; createTask: boolean; active: boolean; version: number };
export type Appointment = { id: string; pageId: string; hostUserId: string; startsAt: string; endsAt: string; status: string; clientId: string | null; suggestedClientId?: string | null; name: string; email: string | null; phone: string | null; purpose: string; taskId: string | null; eventId: string | null; reschedules: number };

export const useCommSettings = (enabled = true) => useQuery({ queryKey: ['comm', 'settings'], enabled, staleTime: 60_000, queryFn: () => as<CommSettings>(api.GET('/comm/settings')) });
export const useTemplates = (enabled = true) => useQuery({ queryKey: ['comm', 'templates'], enabled, queryFn: () => as<Template[]>(api.GET('/comm/templates')) });
export const useConsents = (clientId: string | null) => useQuery({
  queryKey: ['comm', 'consents', clientId], enabled: !!clientId,
  queryFn: () => as<Consent[]>(api.GET('/comm/consents', { params: { query: { clientId: clientId! } } })),
});
export const fetchTimeline = (clientId: string, before: string | undefined, channel: string | undefined) =>
  as<TimelinePage>(api.GET('/clients/{id}/timeline', { params: { path: { id: clientId }, query: { limit: 30, ...(before ? { before } : {}), ...(channel ? { channel } : {}) } as never } }));

/** Error code → p7.err.<code> or the server text. */
export function useCommError() {
  const t = useT();
  return (e: unknown) => {
    const code = (e as { code?: string } | null)?.code?.split(':')[0];
    const key = `p7.err.${code}` as MessageKey;
    if (code && key in en) return t(key);
    return (e as Error | null)?.message || t('common.error');
  };
}
/** Translated label for a dynamic key family with a raw fallback (`p7.status.sent`, `p7.channel.sms`, …). */
export function useLabel() {
  const t = useT();
  return (family: string, v: string | null | undefined) => {
    if (!v) return '';
    const key = `p7.${family}.${v}` as MessageKey;
    return key in en ? t(key) : v;
  };
}
