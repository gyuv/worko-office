import { useQuery } from '@tanstack/react-query';
import type { ProposalFrequency, ProposalStatus, ProposalTotals } from '@worko/domain';
import { api, unwrap } from '../../lib/session';
import type { Lead, StoredLine } from './logic';

/** Typed views of the Phase 9 leads/proposals responses (apps/api/src/leads/*); the spec models several as plain objects. */
export const as = <T>(p: Promise<{ data?: unknown; error?: unknown; response: Response }>) => unwrap(p) as Promise<T>;
export const body = <T>(b: T) => b as never;

/** Like `as`, but keeps the full error body (e.g. 409 duplicate_client carries `candidates`/`hidden`). */
export async function asFull<T>(p: Promise<{ data?: unknown; error?: unknown; response: Response }>): Promise<T> {
  const r = await p;
  if (r.error !== undefined || !r.response.ok) {
    const e = (r.error ?? {}) as { message?: string; code?: string };
    throw Object.assign(new Error(e.message ?? `HTTP ${r.response.status}`), { status: r.response.status, code: e.code, body: r.error });
  }
  return r.data as T;
}

export type Duplicates = { clients: Array<{ id: string; name: string; fileNo?: string | null; matchedOn: string[] }>; hiddenClients: number; leads: Array<{ id: string; name: string; company: string | null; stage: string; matchedOn: string[] }> };
export type Activity = { id: string; kind: string; body: string | null; meta: Record<string, unknown> | null; by: string | null; at: string };
export type LeadDetail = Lead & { activities: Activity[]; proposals: Array<{ id: string; number: string; title: string; status: ProposalStatus; currentVersion: number; sentVersion: number | null; convertedAt: string | null }> };
export type Version = { version: number; lines: StoredLine[]; terms: string | null; validUntil: string | null; totals: ProposalTotals; supplyType: string; sentAt: string | null; sentVia: string | null; createdAt: string };
export type Proposal = {
  id: string; number: string; title: string; leadId: string; leadName: string; company: string | null; status: ProposalStatus; entityId: string | null; placeOfSupply: string | null;
  currentVersion: number; sentVersion: number | null; acceptedVersion: number | null; sentAt: string | null; decidedAt: string | null; acceptedName: string | null; declinedReason: string | null;
  convertedAt: string | null; conversion: Conversion | null; versions: Version[];
};
export type Conversion = { alreadyConverted?: boolean; clientId: string; createdClient?: boolean; contactId: string | null; letterDocumentId: string | null; esignRequestId: string | null; portal: { portalUserId?: string; accessId?: string; invite?: { status?: string }; status?: string; code?: string } | null };
export type PublicProposal = {
  firm: string; accent: string; number: string; title: string; version: number; preparedFor: string | null; terms: string | null; validUntil: string | null; totals: ProposalTotals;
  lines: Array<{ description: string; frequency: ProposalFrequency; qty: number; feePaise: number; discountPaise: number; gstRate: number }>;
  state: 'open' | 'superseded' | 'expired' | 'accepted' | 'declined' | 'withdrawn' | 'not_sent'; acceptable: boolean;
};
export type CrmSettings = { proposalValidityDays: number; engagementLetterTemplate: string; defaultTerms: string };

export const useUsers = (enabled = true) => useQuery({ queryKey: ['users'], queryFn: () => as<Array<{ id: string; name: string }>>(api.GET('/users')), staleTime: 60_000, retry: false, enabled });
export const useCrmSettings = () => useQuery({ queryKey: ['leads', 'settings'], queryFn: () => as<CrmSettings>(api.GET('/leads/settings')), staleTime: 60_000 });
