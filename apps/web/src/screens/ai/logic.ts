import { redact, type AiFeature, type AiGate, type AiSettings, type SuggestionKind, type SuggestionSource } from '@worko/domain';

/** Pure helpers for the Phase 10 AI screens: button visibility, suggestion state/actions, redacted preview. */

export type AiSettingsView = AiSettings & { provider: string; model: string; external: boolean; envNoAi: boolean };
export type Suggestion = {
  id: string; kind: SuggestionKind; feature: AiFeature | null; status: 'pending' | 'approved' | 'rejected' | 'failed'; clientId: string; entityType: string; entityId: string;
  requestedBy: string | null; ruleId: string | null; runId: string | null; provider: string | null; model: string | null; mock: boolean;
  payload: Record<string, unknown> | null; sources: SuggestionSource[] | null; meta: Record<string, unknown> | null; decidedBy: string | null; decidedAt: string | null;
  applied: Record<string, unknown> | null; error: string | null; purged: boolean; createdAt: string;
};

export type AiAvailability = { noAiMode: boolean; features: Partial<Record<AiFeature, AiGate>>; firmCapReached: boolean; userCapReached: boolean; mock: boolean };
/**
 * In-context AI buttons show only when the user may generate (`ai:create`) AND `GET /ai/availability` says the feature's gate
 * is `ok` and no budget is used up. Unknown availability (loading, 403) ⇒ hidden: never invite a click the server will refuse.
 */
export function aiButtonVisible(o: { canCreate: boolean; availability: AiAvailability | null | undefined; feature: AiFeature }): boolean {
  const a = o.availability;
  if (!o.canCreate || !a || a.noAiMode || a.firmCapReached || a.userCapReached) return false;
  return a.features[o.feature] === 'ok';
}
/** Firm-level status line for the settings page. */
export function aiStatus(s: AiSettingsView): 'no_ai_env' | 'no_ai' | 'off' | 'on' {
  if (s.envNoAi) return 'no_ai_env';
  if (s.noAiMode) return 'no_ai';
  return s.enabled ? 'on' : 'off';
}

export type SuggestionAction = 'approve' | 'reject' | 'edit';
/** What a viewer can do with a suggestion right now. */
export function suggestionActions(s: Pick<Suggestion, 'status' | 'kind' | 'purged' | 'payload'>): SuggestionAction[] {
  if (s.status !== 'pending' || s.purged || !s.payload) return s.status === 'pending' ? ['reject'] : [];
  const editable = s.kind === 'draft_reply' || s.kind === 'draft_message' || s.kind === 'summary' || s.kind === 'classification';
  return editable ? ['edit', 'approve', 'reject'] : ['approve', 'reject'];
}
/** The editable text form of a suggestion's payload. */
export type Editable = { subject: string; body: string; category: string; fy: string };
export function editableOf(s: Pick<Suggestion, 'payload'>): Editable {
  const p = s.payload ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { subject: str(p.subject), body: str(p.body) || str(p.summary), category: str(p.category), fy: str(p.fy) };
}
/** Approve body: only fields the kind takes, only when edited (so the server records `edited` truthfully). */
export function approveBody(s: Pick<Suggestion, 'kind' | 'payload'>, e: Editable): Record<string, unknown> {
  const o = editableOf(s);
  const b: Record<string, unknown> = {};
  if (s.kind === 'draft_reply' || s.kind === 'draft_message') {
    if (e.body !== o.body) b.body = e.body;
    if (e.subject !== o.subject) b.subject = e.subject.trim() || null;
  } else if (s.kind === 'summary') { if (e.body !== o.body) b.body = e.body; }
  else if (s.kind === 'classification') {
    if (e.category !== o.category) b.category = e.category;
    if (e.fy !== o.fy) b.fy = e.fy.trim() || null;
  }
  return b;
}
export function editErrors(kind: SuggestionKind, e: Editable): Partial<Record<keyof Editable, 'required' | 'fy'>> {
  const out: Partial<Record<keyof Editable, 'required' | 'fy'>> = {};
  if ((kind === 'draft_reply' || kind === 'draft_message' || kind === 'summary') && !e.body.trim()) out.body = 'required';
  if (kind === 'classification') {
    if (!e.category.trim()) out.category = 'required';
    if (e.fy.trim() && !/^\d{4}-\d{2}$/.test(e.fy.trim())) out.fy = 'fy';
  }
  return out;
}

/**
 * What the model saw: the restored text redacted again with the same rules the server uses (PAN, Aadhaar, GSTIN, TAN, IFSC,
 * bank, phone, email, client names). Shown next to the restored text so a reviewer sees what left the system.
 */
export function redactedPreview(text: string, names: string[]): string {
  return redact(text, { names }).text;
}
export const sourceHref = (s: SuggestionSource, clientId: string): string | null =>
  s.type === 'client' ? `#/clients/${s.id}` : s.type === 'notice' ? `#/notices/${s.id}` : s.type === 'document' ? `#/clients/${clientId}` : s.type === 'rule' ? `#/automation/rules/${s.id}` : s.type === 'comm_message' ? `#/clients/${clientId}` : null;
