import { useQuery } from '@tanstack/react-query';
import { en, type MessageKey } from '@worko/i18n';
import type { FieldSuggestion, NoticeStatus } from '@worko/domain';
import { absoluteUrl, multipart } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { as } from '../hr/api';

/**
 * Typed views of the Phase 8 responses (the spec models most bodies as plain objects); shapes mirror the presenters
 * in apps/api/src/practice/*. Request bodies are passed through `body()`.
 */
export { as, body } from '../hr/api';

export type Notice = {
  id: string; clientId: string; clientName: string | null; authority: string; level: string; section: string | null; referenceNo: string | null; din: string | null;
  title: string; description: string | null; issueDate: string | null; receivedOn: string; responseDue: string | null; assessmentYear: string | null; financialYear: string | null;
  period: string | null; demandPaise: number; status: NoticeStatus; outcome: string | null; outcomeNote: string | null; finalDemandPaise: number | null;
  assigneeId: string | null; reviewerId: string | null; taskId: string | null; appealOf: string | null; closedAt: string | null; version: number; createdAt: string;
};
export type Hearing = { id: string; noticeId: string; startsAt: string; endsAt: string | null; venue: string | null; virtualLink: string | null; status: string; adjournedFrom: string | null;
  adjournmentReason: string | null; prepDone: boolean; outcomeNote: string | null; ownerId: string | null; calendarEventId: string | null };
export type NoticeDoc = { documentId: string; kind: string; name: string; currentVersion: number; linkedAt: string };
export type NoticeDetail = Notice & { documents: NoticeDoc[]; hearings: Hearing[] };
export type Ageing = { asOf: string; open: number; overdue: number; demandPaise: number; buckets: Array<{ bucket: string; count: number; demandPaise: number }>;
  byAuthority: Array<{ authority: string; level: string; count: number; demandPaise: number }> };
export type Extraction = { id: string; documentId: string; provider: string; suggestions: FieldSuggestion[]; status: string };

export type ProgrammeSection = { key: string; title: string; procedures: Array<{ key: string; title: string; evidence: string[] }> };
export type Programme = { id: string; name: string; auditType: string; sections: ProgrammeSection[]; udinRequired: boolean; active: boolean; version: number };
export type Engagement = { id: string; clientId: string; clientName: string | null; fy: string; auditType: string; programmeId: string | null; partnerId: string | null; managerId: string | null;
  taskId: string | null; status: string; udinRequired: boolean; udinRecorded: boolean | null; version: number; createdAt: string };
export type Procedure = { id: string; sectionKey: string; sectionTitle: string; key: string; title: string; requiredEvidence: string[]; notApplicable: boolean; conclusion: string | null;
  preparedBy: string | null; preparedAt: string | null; reviewedBy: string | null; reviewedAt: string | null; partnerBy: string | null; partnerAt: string | null; workpapers: number };
export type Pbc = { id: string; engagementId: string; title: string; description: string | null; dueDate: string | null; status: string; documentIds: string[]; rejectionReason: string | null;
  reminderCount: number; lastRemindedOn: string | null };
export type Udin = { id: string; clientId: string; engagementId: string | null; taskId: string | null; udin: string; documentType: string; generatedOn: string; membershipNo: string;
  signingPartnerId: string | null; documentId: string | null; revokedAt: string | null; revokeReason: string | null; createdAt: string };
export type EngagementDetail = Engagement & { procedures: Procedure[]; pbc: Pbc[]; udins: Udin[]; progress: { total: number; prepared: number; reviewed: number; partner: number }; udinPortalUrl: string };
export type Workpaper = { id: string; documentId: string; name: string; documentVersion: number; currentVersion: number; linkedBy: string; linkedAt: string };
export type TrailRow = { level: string; action: string; userId: string | null; userName: string | null; reason: string | null; at: string };

export type Dsc = { id: string; clientId: string | null; clientName: string | null; holderKind: 'client_contact' | 'staff'; contactId: string | null; holderUserId: string | null; holderName: string;
  dscClass: string; dscType: string; issuer: string; serialNo: string | null; validFrom: string; validTo: string; tokenLabel: string | null; custody: string; custodyUserId: string | null;
  alertsSent: number[]; renewalTaskId: string | null; notes: string | null; version: number };
export type Custody = { id: string; fromCustody: string | null; toCustody: string; toUserId: string | null; counterparty: string | null; purpose: string | null; movedBy: string; movedAt: string;
  acknowledgedAt: string | null; acknowledgedBy: string | null; acknowledgedName: string | null };
export type DscDetail = Dsc & { daysLeft: number; custodyLog: Custody[] };
export type Licence = { id: string; clientId: string; clientName: string | null; licenceType: string; number: string | null; authority: string | null; validFrom: string | null; validTo: string | null;
  renewalDue: string | null; documentIds: string[]; alertsSent: number[]; renewalTaskId: string | null; status: string; notes: string | null; version: number };

export type EsignRow = { id: string; title: string; bulk: boolean; mode: string; provider: string; status: string; items: number; visibleItems: number; createdAt: string; completedAt: string | null };
export type EsignSigner = { id: string; ord: number; kind: string; contactId: string | null; userId: string | null; name: string; status: string; notifiedAt: string | null; signedAt: string | null; maskedId: string | null };
export type EsignItem = { id: string; documentId: string; documentName: string; documentVersion: number; clientId: string; status: string; error: string | null; attempts: number;
  providerTxnId: string | null; signedVersion: number | null; certificateDocumentId: string | null; originalSha256: string; signedSha256: string | null; signers: EsignSigner[] };
export type EsignDetail = { id: string; title: string; bulk: boolean; mode: string; provider: string; status: string; createdAt: string; completedAt: string | null; items: EsignItem[] };

export type PracticeSettings = {
  notices: { taskBufferDays: number; hearingPrepDays: number; escalateAfterMinutes: number; hearingReminderMinutesBefore: number[] };
  dsc: { thresholds: number[]; renewalTaskDays: number }; licences: { thresholds: number[]; renewalTaskDays: number };
  pbc: { reminderEveryDays: number; maxReminders: number; channel: 'email' | 'whatsapp' | 'sms' }; ai: { noticeExtraction: boolean };
};

export type Contact = { id: string; name: string; email: string | null; phone: string | null; isPrimary: boolean };
export type ClientDoc = { id: string; name: string; mime: string; currentVersion: number; clientId?: string | null; category: string };

export const useClientContacts = (clientId: string | null) => useQuery({
  queryKey: ['client', clientId], enabled: !!clientId, retry: false,
  queryFn: () => unwrap(api.GET('/clients/{id}', { params: { path: { id: clientId! } } })),
});
export const useClientDocs = (clientId: string | null) => useQuery({
  queryKey: ['p8', 'docs', clientId], enabled: !!clientId,
  queryFn: async () => (await unwrap(api.GET('/documents', { params: { query: { clientId: clientId!, limit: 200 } as never } }))).items as ClientDoc[],
});
export const usePracticeSettings = (enabled = true) => useQuery({ queryKey: ['p8', 'settings'], enabled, queryFn: () => as<PracticeSettings>(api.GET('/practice/settings')) });

/** Uploads a client document (new or a new version of `documentId`). */
export const uploadDoc = (f: { file: File; clientId: string; category?: string; documentId?: string }) =>
  unwrap(api.POST('/documents', { body: multipart({ file: f.file, clientId: f.clientId, category: f.category, documentId: f.documentId }) })) as Promise<{ id: string; version?: number }>;

export async function openDoc(id: string, version?: number) {
  const r = await unwrap(api.POST('/documents/{id}/download-url', { params: { path: { id } }, body: version ? { version } : {} }));
  window.open(absoluteUrl(r.url), '_blank', 'noopener');
}

/** Error code → p8.err.<code>, else server text. */
export function useP8Error() {
  const t = useT();
  return (e: unknown) => {
    const code = (e as { code?: string } | null)?.code?.split(':')[0];
    const key = `p8.err.${code}` as MessageKey;
    if (code && key in en) return t(key);
    return (e as Error | null)?.message || t('common.error');
  };
}
/** Translated label for a dynamic key family with a readable fallback (`p8.nstatus.drafting`, `p8.level.itat` …). */
export function useP8Label() {
  const t = useT();
  return (family: string, v: string | null | undefined) => {
    if (!v) return '';
    const key = `p8.${family}.${v}` as MessageKey;
    return key in en ? t(key) : v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  };
}
