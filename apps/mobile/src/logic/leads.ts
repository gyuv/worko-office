import { LEAD_STAGES, leadTransitionError, type LeadStage } from '@worko/domain';
import { parsePaise } from './billing';
import { todayIST } from './registers';

/** Staff leads pipeline on Android (Phase 9, D131): online REST; kanban grouping and move validation mirror the server. */

export type LeadItem = {
  id: string; name: string; company: string | null; email: string | null; phone: string | null; stage: LeadStage; position: number;
  expectedValuePaise: number; nextFollowupOn: string | null; clientId: string | null; lostReason: string | null;
};

export function toLeadItem(r: Record<string, unknown>): LeadItem {
  const stage = (LEAD_STAGES as readonly string[]).includes(String(r.stage)) ? (r.stage as LeadStage) : 'new';
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  return { id: String(r.id), name: String(r.name ?? ''), company: s(r.company), email: s(r.email), phone: s(r.phone), stage, position: Number(r.position ?? 0),
    expectedValuePaise: parsePaise(r.expectedValuePaise), nextFollowupOn: s(r.nextFollowupOn)?.slice(0, 10) ?? null, clientId: s(r.clientId), lostReason: s(r.lostReason) };
}

export type Column = { stage: LeadStage; items: LeadItem[]; valuePaise: number };

/** One column per stage in pipeline order (empty ones included), items by position. */
export function groupBoard(leads: LeadItem[]): Column[] {
  return LEAD_STAGES.map((stage) => {
    const items = leads.filter((l) => l.stage === stage).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    return { stage, items, valuePaise: items.reduce((s, l) => s + l.expectedValuePaise, 0) };
  });
}

export type MoveCheck = 'convert_to_win' | 'lost_reason_required' | 'lead_won_final' | 'invalid_transition' | 'same_stage' | null;

/** Domain rules + the server's "win only through conversion" rule (a lead without a client cannot be dragged to won). */
export function moveError(l: LeadItem, to: LeadStage, lostReason?: string | null): MoveCheck {
  if (l.stage === to) return 'same_stage';
  const e = leadTransitionError(l.stage, to, lostReason) as MoveCheck;
  if (e) return e;
  if (to === 'won' && !l.clientId) return 'convert_to_win';
  return null;
}

/** Stages offered in the picker; `needsReason` for lost. A lost-reason error is not a block (the picker asks for it). */
export function moveTargets(l: LeadItem): Array<{ stage: LeadStage; blocked: MoveCheck; needsReason: boolean }> {
  return LEAD_STAGES.filter((s) => s !== l.stage).map((stage) => {
    const e = moveError(l, stage, stage === 'lost' ? 'x' : null);
    return { stage, blocked: e, needsReason: stage === 'lost' };
  });
}

/** Body for POST /leads/{id}/move: append to the end of the target column (beforeId = its last card). */
export function moveBody(board: Column[], l: LeadItem, to: LeadStage, lostReason?: string | null): { stage: LeadStage; beforeId: string | null; afterId: null; lostReason: string | null } {
  const col = board.find((c) => c.stage === to);
  const last = col?.items.filter((x) => x.id !== l.id).at(-1);
  return { stage: to, beforeId: last?.id ?? null, afterId: null, lostReason: to === 'lost' ? lostReason?.trim() || null : null };
}

/** Optimistic local move (same placement as moveBody). */
export function applyMove(board: Column[], l: LeadItem, to: LeadStage): Column[] {
  const flat = board.flatMap((c) => c.items).filter((x) => x.id !== l.id);
  const target = flat.filter((x) => x.stage === to);
  const pos = (target.at(-1)?.position ?? 0) + 1024;
  return groupBoard([...flat, { ...l, stage: to, position: pos }]);
}

export function followupState(l: LeadItem, today = todayIST()): 'overdue' | 'today' | 'upcoming' | null {
  if (!l.nextFollowupOn || l.stage === 'won' || l.stage === 'lost') return null;
  return l.nextFollowupOn < today ? 'overdue' : l.nextFollowupOn === today ? 'today' : 'upcoming';
}

export const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
