import { nextRunAt, scheduleSchema, type AiFeature, type Schedule } from '@worko/domain';
import { hasGrant, parsePaise } from './billing';

/**
 * Phase 10 on Android (D141–D152): automation monitoring + AI suggestion approval. Online REST only — suggestions
 * are never synced. Pure helpers so visibility, transitions and summaries are testable without React Native.
 */

type Grant = { module: string; action: string; scope: string };

// ---------- AI button visibility ----------
/** `GET /ai/availability` (ai:view): effective per-feature gate + budget flags, no settings detail. Null on error → hidden. */
export type AiAvailability = { noAiMode?: boolean; features?: Record<string, string>; firmCapReached?: boolean; userCapReached?: boolean; mock?: boolean };

/** Show "Summarise" / "Draft reply" only if the feature gate is ok, no budget is used up and the user has ai:create. */
export function aiFeatureVisible(av: AiAvailability | null | undefined, feature: AiFeature, grants: Grant[] | undefined): boolean {
  if (!av || !hasGrant(grants, 'ai', 'create')) return false;
  if (av.noAiMode === true || av.firmCapReached === true || av.userCapReached === true) return false;
  return av.features?.[feature] === 'ok';
}

// ---------- Suggestions ----------
export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'failed';
export type SuggestionAction = 'approve' | 'reject';
export type Suggestion = {
  id: string; kind: string; status: SuggestionStatus; clientId: string | null; mock: boolean; createdAt: string; error: string | null;
  draft: { subject: string | null; body: string } | null; summary: string | null; points: string[];
  classification: { category: string; fy: string | null } | null;
  sources: Array<{ type: string; id: string; label?: string; snippet?: string }>;
};

export function toSuggestion(r: Record<string, unknown>): Suggestion {
  const p = (r.payload ?? {}) as Record<string, unknown>;
  const status = (['pending', 'approved', 'rejected', 'failed'] as const).find((s) => s === r.status) ?? 'failed';
  const body = typeof p.body === 'string' ? p.body : null;
  return {
    id: String(r.id), kind: String(r.kind ?? ''), status, clientId: r.clientId ? String(r.clientId) : null, mock: r.mock === true, createdAt: String(r.createdAt ?? ''),
    error: r.error ? String(r.error) : null,
    draft: body != null ? { subject: typeof p.subject === 'string' ? p.subject : null, body } : null,
    summary: typeof p.summary === 'string' ? p.summary : null, points: Array.isArray(p.points) ? p.points.map(String) : [],
    classification: typeof p.category === 'string' ? { category: p.category, fy: typeof p.fy === 'string' ? p.fy : null } : null,
    sources: Array.isArray(r.sources) ? (r.sources as Suggestion['sources']) : [],
  };
}

/** Only pending suggestions can be decided; approved/rejected are final, failed can only be rejected (dismissed). */
export function allowedActions(status: SuggestionStatus): SuggestionAction[] {
  return status === 'pending' ? ['approve', 'reject'] : status === 'failed' ? ['reject'] : [];
}
export function transition(status: SuggestionStatus, action: SuggestionAction): SuggestionStatus | 'already_decided' {
  if (!allowedActions(status).includes(action)) return 'already_decided';
  return action === 'approve' ? 'approved' : 'rejected';
}
/** Approve body: only edited fields are sent; an emptied body is refused rather than sent blank. */
export function approveBody(s: Suggestion, edited: { subject?: string | null; body?: string }): { ok: true; body: Record<string, unknown> } | { ok: false; error: 'empty_body' } {
  if (!s.draft) return { ok: true, body: {} };
  const out: Record<string, unknown> = {};
  if (edited.body !== undefined) {
    if (!edited.body.trim()) return { ok: false, error: 'empty_body' };
    if (edited.body.trim() !== s.draft.body.trim()) out.body = edited.body.trim();
  }
  if (edited.subject !== undefined && (edited.subject?.trim() || null) !== (s.draft.subject ?? null)) out.subject = edited.subject?.trim() || null;
  return { ok: true, body: out };
}
export const rejectBody = (reason: string) => (reason.trim() ? { reason: reason.trim().slice(0, 500) } : {});

const AI_ERRORS = ['no_ai_mode', 'ai_disabled', 'feature_disabled', 'ai_cap', 'already_decided', 'expired', 'no_consent', 'quiet_hours', 'cap_reached'] as const;
/** Known codes get a friendly line; anything else shows the service's own message plainly. */
export function aiErrorCode(code: string | undefined): (typeof AI_ERRORS)[number] | null {
  return (AI_ERRORS as readonly string[]).includes(String(code)) ? (code as (typeof AI_ERRORS)[number]) : null;
}

// ---------- Dry-run summary ----------
export type DryRunSummary = { evaluated: number; matched: number; skipped: number; actions: number; refused: number; estimatedCostPaise: number; refusals: Array<[string, number]> };
export function dryRunSummary(r: Record<string, unknown> | null | undefined): DryRunSummary {
  const items = Array.isArray(r?.items) ? (r!.items as Array<Record<string, unknown>>) : [];
  const refusals = Object.entries((r?.refusals ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0] as [string, number]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    evaluated: Number(r?.evaluated ?? items.length) || 0, matched: Number(r?.matched ?? 0) || 0, skipped: items.filter((i) => !!i.skipped).length,
    actions: Number(r?.actions ?? 0) || 0, refused: refusals.reduce((n, [, c]) => n + c, 0), estimatedCostPaise: parsePaise(r?.estimatedCostPaise ?? 0), refusals,
  };
}

// ---------- Runs ----------
export const ACTION_STATUSES = ['failed', 'refused', 'rate_limited', 'queued', 'done', 'skipped'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type RunAction = { idx: number; type: string; status: ActionStatus; code: string | null; error: string | null; costPaise: number };
export function toRunAction(a: Record<string, unknown>): RunAction {
  const raw = a.code === 'rate_limited' ? 'rate_limited' : String(a.status);
  return { idx: Number(a.idx ?? 0), type: String(a.type ?? ''), status: (ACTION_STATUSES as readonly string[]).includes(raw) ? (raw as ActionStatus) : 'failed',
    code: a.code ? String(a.code) : null, error: a.error ? String(a.error) : null, costPaise: parsePaise(a.costPaise ?? 0) };
}
/** Problems first; empty groups dropped; retry offered when anything failed. */
export function groupRunActions(actions: RunAction[]): { groups: Array<{ status: ActionStatus; items: RunAction[] }>; retryable: boolean; costPaise: number } {
  const groups = ACTION_STATUSES.map((status) => ({ status, items: actions.filter((a) => a.status === status).sort((a, b) => a.idx - b.idx) })).filter((g) => g.items.length);
  return { groups, retryable: actions.some((a) => a.status === 'failed'), costPaise: actions.reduce((n, a) => n + a.costPaise, 0) };
}
export const runRetryable = (status: string) => status === 'failed' || status === 'partial';

// ---------- Rules / schedule ----------
export type RuleItem = { id: string; name: string; enabled: boolean; paused: boolean; pausedReason: string | null; agentKey: string | null; trigger: string; schedule: Schedule | null; nextRunAt: string | null };
export function toRuleItem(r: Record<string, unknown>): RuleItem {
  const def = (r.definition ?? {}) as { trigger?: { kind?: string; event?: string; schedule?: unknown } };
  const sch = def.trigger?.kind === 'schedule' ? scheduleSchema.safeParse(def.trigger.schedule) : null;
  return { id: String(r.id), name: String(r.name ?? ''), enabled: r.enabled === true, paused: r.status === 'paused', pausedReason: r.pausedReason ? String(r.pausedReason) : null,
    agentKey: r.agentKey ? String(r.agentKey) : null, trigger: String(r.triggerEvent ?? def.trigger?.event ?? 'schedule'), schedule: sch?.success ? sch.data : null,
    nextRunAt: r.nextRunAt ? String(r.nextRunAt) : null };
}
/** Agents list joined with the firm rule each one instantiated (latest wins). */
export function agentStates(agents: Array<{ key: string; name: string; description: string }>, rules: RuleItem[]) {
  return agents.map((a) => { const rule = rules.filter((r) => r.agentKey === a.key).pop() ?? null; return { ...a, rule, on: !!rule?.enabled && !rule.paused }; });
}

const IST = 330 * 60_000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
/** IST wall-clock "yyyy-mm-dd HH:MM" for an instant, independent of the device zone. */
export function istStamp(d: Date): string { return new Date(d.getTime() + IST).toISOString().slice(0, 16).replace('T', ' '); }
/** i18n key + params for a schedule, with the next slot computed by the domain helper (IST, no DST). */
export function scheduleText(s: Schedule, now: Date): { key: 'm.auto.sched.daily' | 'm.auto.sched.weekly' | 'm.auto.sched.monthly'; params: { at: string; day: string; next: string }; weekday: (typeof WEEKDAYS)[number] | null } {
  const next = istStamp(nextRunAt(s, now));
  return { key: `m.auto.sched.${s.freq}`, params: { at: s.at, day: s.freq === 'monthly' ? String(s.monthDay) : '', next }, weekday: s.freq === 'weekly' ? WEEKDAYS[s.weekday ?? 0]! : null };
}

// ---------- Notification taps ----------
export type Phase10Route = { name: 'automation'; runId?: string } | { name: 'aiInbox'; id?: string };
export function routeForCategory(category: string, entityId?: string | null): Phase10Route | null {
  if (category === 'automation.alert' || category === 'automation.failed') return { name: 'automation', runId: entityId ?? undefined };
  if (category === 'ai.suggestion') return { name: 'aiInbox', id: entityId ?? undefined };
  return null;
}
