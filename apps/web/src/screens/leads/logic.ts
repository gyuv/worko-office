import { formatINR, PROPOSAL_FREQUENCIES, type LeadStage, type ProposalFrequency, type ProposalTotals, type VersionDiff } from '@worko/domain';

/** Leads & proposals — pure helpers (kanban moves, totals rows, diff rows, links, rate prefill). */
export type Lead = {
  id: string; name: string; company: string | null; email: string | null; phone: string | null; pan: string | null; gstin: string | null; entityType: string | null; stateCode: string | null;
  source: string; ownerId: string | null; stage: LeadStage; position: number; lostReason: string | null; expectedValuePaise: number; nextFollowupOn: string | null; notes: string | null;
  clientId: string | null; convertedAt: string | null; createdAt: string; version: number;
};
export type Column = { stage: LeadStage; count: number; valuePaise: number; items: Lead[] };

/**
 * Drop `id` into `stage` at visual `index` (index among the target column's cards, excluding the moved card).
 * Returns the API neighbours: `beforeId` = card above, `afterId` = card below (server puts the lead strictly between).
 */
export function dropNeighbours(column: Lead[], id: string, index: number): { beforeId: string | null; afterId: string | null } {
  const rest = column.filter((l) => l.id !== id);
  const i = Math.max(0, Math.min(index, rest.length));
  return { beforeId: rest[i - 1]?.id ?? null, afterId: rest[i]?.id ?? null };
}

/** Optimistic board after a move (recomputes counts and values). */
export function applyMove(board: Column[], id: string, stage: LeadStage, index: number, lostReason?: string | null): Column[] {
  const lead = board.flatMap((c) => c.items).find((l) => l.id === id);
  if (!lead) return board;
  const moved: Lead = { ...lead, stage, lostReason: stage === 'lost' ? (lostReason ?? lead.lostReason) : null };
  return board.map((c) => {
    let items = c.items.filter((l) => l.id !== id);
    if (c.stage === stage) { const i = Math.max(0, Math.min(index, items.length)); items = [...items.slice(0, i), moved, ...items.slice(i)]; }
    return { ...c, items, count: items.length, valuePaise: items.reduce((s, l) => s + l.expectedValuePaise, 0) };
  });
}

export function filterBoard(board: Column[], f: { ownerId?: string; source?: string; q?: string }): Column[] {
  const q = f.q?.trim().toLowerCase();
  return board.map((c) => {
    const items = c.items.filter((l) => (!f.ownerId || l.ownerId === f.ownerId) && (!f.source || l.source === f.source)
      && (!q || `${l.name} ${l.company ?? ''} ${l.email ?? ''}`.toLowerCase().includes(q)));
    return { ...c, items, count: items.length, valuePaise: items.reduce((s, l) => s + l.expectedValuePaise, 0) };
  });
}

/** Moves the server would refuse (mirrors leadTransitionError + convert_to_win), so the UI can explain before calling. */
export function moveBlocked(from: LeadStage, to: LeadStage, hasClient: boolean): 'lead_won_final' | 'invalid_transition' | 'convert_to_win' | null {
  if (from === to) return null;
  if (from === 'won') return 'lead_won_final';
  if (from === 'lost' && !['new', 'contacted', 'qualified'].includes(to)) return 'invalid_transition';
  if (to === 'won' && !hasClient) return 'convert_to_win';
  return null;
}

// ---------- Proposals ----------
export type ProposalLineIn = { serviceTypeId: string | null; description: string; frequency: ProposalFrequency; qty: number; feeRupees: string; override: boolean; gstRate: string; discountRupees: string };
export const emptyLine = (): ProposalLineIn => ({ serviceTypeId: null, description: '', frequency: 'annual', qty: 1, feeRupees: '', override: false, gstRate: '', discountRupees: '' });

const rupeesToPaise = (s: string): number | null => {
  const t = s.replace(/[,₹\s]/g, '');
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
};
export const paiseToRupees = (p: number | null | undefined) => (p === null || p === undefined ? '' : (p / 100).toFixed(2).replace(/\.00$/, ''));

/** Editor line → API body. Catalogue lines without an override omit the fee (server uses the rate table on the date). */
export function linePayload(l: ProposalLineIn): Record<string, unknown> | { error: string } {
  const fee = rupeesToPaise(l.feeRupees);
  const disc = rupeesToPaise(l.discountRupees);
  const gst = l.gstRate.trim() === '' ? null : Number(l.gstRate);
  if (Number.isNaN(fee) || Number.isNaN(disc) || (gst !== null && (Number.isNaN(gst) || gst < 0 || gst > 28))) return { error: 'invalid_amount' };
  if (!l.serviceTypeId && (!l.description.trim() || fee === null)) return { error: 'free_line' };
  if (!(l.qty > 0)) return { error: 'invalid_amount' };
  return {
    serviceTypeId: l.serviceTypeId, frequency: l.frequency, qty: l.qty,
    ...(l.description.trim() ? { description: l.description.trim() } : {}),
    ...(!l.serviceTypeId || l.override ? { feePaise: fee } : {}),
    ...(gst !== null ? { gstRate: gst } : {}), ...(disc ? { discountPaise: disc } : {}),
  };
}

export type StoredLine = { serviceTypeId: string | null; description: string; frequency: ProposalFrequency; qty: number; feePaise: number; gstRate: number; discountPaise?: number };
export const lineFromStored = (l: StoredLine, fromRate: boolean): ProposalLineIn => ({
  serviceTypeId: l.serviceTypeId, description: l.description, frequency: l.frequency, qty: l.qty, feeRupees: paiseToRupees(l.feePaise), override: !fromRate || !l.serviceTypeId,
  gstRate: String(l.gstRate), discountRupees: l.discountPaise ? paiseToRupees(l.discountPaise) : '',
});

export type Rate = { id: string; serviceTypeId: string; clientId: string | null; groupId: string | null; amountPaise: number; effectiveFrom: string; effectiveTo: string | null };
/** Firm-wide default rate on `today` (client/group overrides don't apply to a lead): latest effectiveFrom wins. */
export function defaultRate(rates: Rate[], serviceTypeId: string, today: string): Rate | null {
  return rates.filter((r) => r.serviceTypeId === serviceTypeId && !r.clientId && !r.groupId && r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo >= today))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

export type TotalsRow = { key: ProposalFrequency | 'firstYear'; taxablePaise: number; taxPaise: number; totalPaise: number };
/** Display rows for API totals: frequencies with value, then first-year contract value. Rounded to whole paise for display. */
export function totalsRows(t: ProposalTotals | null | undefined): TotalsRow[] {
  if (!t) return [];
  const r = (x: { taxablePaise: number; taxPaise: number; totalPaise: number }) => ({ taxablePaise: Math.round(x.taxablePaise), taxPaise: Math.round(x.taxPaise), totalPaise: Math.round(x.totalPaise) });
  return [...PROPOSAL_FREQUENCIES.filter((f) => t.byFrequency[f]?.totalPaise).map((f) => ({ key: f, ...r(t.byFrequency[f]) })), { key: 'firstYear' as const, ...r(t.firstYear) }];
}

export type DiffRow = { kind: 'added' | 'removed' | 'changed' | 'terms' | 'validity'; label: string; details: string[] };
const fmtField = (f: string, v: unknown) => (f === 'feePaise' || f === 'discountPaise' ? formatINR(Number(v ?? 0)) : f === 'gstRate' ? `${v}%` : String(v ?? ''));
/** Version diff → readable rows ("Fee: ₹10,000.00 → ₹12,000.00"). */
export function diffRows(d: VersionDiff, fieldLabel: (f: string) => string = (f) => f): DiffRow[] {
  return [
    ...d.added.map((l) => ({ kind: 'added' as const, label: l.description, details: [`${formatINR(l.feePaise)} × ${l.qty} · ${l.frequency}`] })),
    ...d.removed.map((l) => ({ kind: 'removed' as const, label: l.description, details: [`${formatINR(l.feePaise)} × ${l.qty} · ${l.frequency}`] })),
    ...d.changed.map((c) => ({ kind: 'changed' as const, label: c.to.description, details: c.fields.map((f) => `${fieldLabel(f)}: ${fmtField(f, (c.from as Record<string, unknown>)[f])} → ${fmtField(f, (c.to as Record<string, unknown>)[f])}`) })),
    ...(d.terms ? [{ kind: 'terms' as const, label: '', details: [] }] : []),
    ...(d.validUntil ? [{ kind: 'validity' as const, label: '', details: [] }] : []),
  ];
}

/** API e-accept link (`…/v1/proposals/public/<token>`) → the web accept page `#/proposal/<token>`. */
export function proposalWebHref(apiLink: string): string {
  const m = /\/proposals\/public\/([^/?#]+)/.exec(apiLink);
  return m ? `#/proposal/${m[1]}` : apiLink;
}
/** `#/proposal/<token>` (or the API-shaped path `/proposals/public/<token>`) → token. */
export function proposalPublicToken(hash: string, pathname = ''): string | null {
  const h = /^#\/?proposal\/([^/?]+)/.exec(hash);
  const p = h ? null : /^\/?(?:v1\/)?proposals\/public\/([^/?]+)/.exec(pathname.replace(/^\/+/, ''));
  const tok = h?.[1] ?? p?.[1];
  if (!tok) return null;
  try { return decodeURIComponent(tok); } catch { return tok; }
}
