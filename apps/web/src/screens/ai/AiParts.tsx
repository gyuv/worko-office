import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CommChannel } from '@worko/domain';
import { formatDateTime } from '@worko/i18n';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/session';
import { asFull, body, useAiError, useAiFeature } from './api';
import { approveBody, editableOf, editErrors, redactedPreview, sourceHref, suggestionActions, type Editable, type Suggestion } from './logic';

/** Shown on every AI output. */
export function AiBadge() {
  const t = useT();
  return <span data-testid="ai-badge" className="inline-flex items-center gap-1 rounded border border-due-soon px-1.5 py-0.5 text-xs text-due-soon"><Sparkles size={12} aria-hidden /> {t('p10.ai.badge')}</span>;
}

/** Sources, redacted-vs-restored text, edit-before-approve, approve/reject with reason. Server errors are shown as they are. */
export function SuggestionReview({ s, onDone, clientNames = [] }: { s: Suggestion; onDone?(): void; clientNames?: string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useAiError();
  const acts = suggestionActions(s);
  const [e, setE] = useState<Editable>(editableOf(s));
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showRedacted, setShowRedacted] = useState(false);
  const errs = editErrors(s.kind, e);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['ai', 'suggestions'] }); void qc.invalidateQueries({ queryKey: ['comm', 'timeline'] }); void qc.invalidateQueries({ queryKey: ['documents'] }); };
  const approve = useMutation({
    mutationFn: () => asFull<{ applied: Record<string, unknown> }>(api.POST('/ai/suggestions/{id}/approve', { params: { path: { id: s.id } }, body: body(approveBody(s, e)) })),
    onSuccess: () => { refresh(); toast({ text: t(`p10.ai.applied.${s.kind}` as 'p10.ai.applied.summary'), tone: 'ok' }, 4000); onDone?.(); },
    onError: (x) => setError(err(x)),
  });
  const reject = useMutation({
    mutationFn: () => asFull(api.POST('/ai/suggestions/{id}/reject', { params: { path: { id: s.id } }, body: body(reason.trim() ? { reason: reason.trim() } : {}) })),
    onSuccess: () => { refresh(); toast({ text: t('p10.ai.rejected'), tone: 'ok' }, 3000); onDone?.(); },
    onError: (x) => setError(err(x)),
  });
  const names = [...clientNames, ...(s.sources ?? []).filter((x) => x.type === 'client' && x.label).map((x) => x.label!)];
  const isText = s.kind !== 'classification' && s.kind !== 'esign_request';
  const editing = acts.includes('edit');
  const p = s.payload ?? {};
  return (
    <div className="space-y-3" data-testid={`suggestion-${s.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <AiBadge />
        <span>{t(`p10.kind.${s.kind}` as 'p10.kind.summary')}</span>
        {s.mock && <span className="rounded border border-due-soon px-1.5 py-0.5 text-due-soon">{t('p10.ai.mockProvider')}</span>}
        {s.provider && <span>{s.provider}{s.model ? ` · ${s.model}` : ''}</span>}
        <time dateTime={s.createdAt}>{formatDateTime(s.createdAt)}</time>
      </div>
      {!!s.sources?.length && <section aria-label={t('p10.ai.sources')}>
        <h3 className="label">{t('p10.ai.sources')}</h3>
        <ul className="flex flex-wrap gap-2 text-sm">{s.sources.map((x) => { const href = sourceHref(x, s.clientId); return (
          <li key={`${x.type}:${x.id}`} className="rounded bg-surface-alt px-2 py-0.5">{t(`p10.src.${x.type}` as 'p10.src.client')}: {href ? <a className="underline" href={href}>{x.label ?? x.id.slice(0, 8)}</a> : x.label ?? x.id.slice(0, 8)}</li>); })}</ul>
        {Array.isArray(p.snippets) && <ul className="mt-1 space-y-1 text-xs text-muted">{(p.snippets as Array<{ id: string; text: string }>).map((x) => <li key={x.id} className="border-l-2 border-border pl-2">{x.text}</li>)}</ul>}
      </section>}
      {s.purged && <p className="text-sm text-muted">{t('p10.ai.purged')}</p>}
      {s.status === 'failed' && <p role="alert" className="text-sm text-overdue">{s.error ?? t('common.error')}</p>}
      {s.payload && isText && <>
        {(s.kind === 'draft_reply' || s.kind === 'draft_message') && <Field label={t('p7.f.subject')}>
          <input className="input" value={e.subject} readOnly={!editing} onChange={(x) => setE({ ...e, subject: x.target.value })} /></Field>}
        <Field label={s.kind === 'summary' ? t('p10.ai.summary') : t('p7.f.message')} error={errs.body ? t('p10.v.required') : null}>
          <textarea className="input min-h-32" value={e.body} readOnly={!editing} onChange={(x) => setE({ ...e, body: x.target.value })} /></Field>
        {s.kind === 'summary' && Array.isArray(p.points) && !!(p.points as string[]).length && <ul className="list-disc pl-5 text-sm">{(p.points as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul>}
        <button type="button" className="text-xs underline" aria-expanded={showRedacted} onClick={() => setShowRedacted(!showRedacted)}>{showRedacted ? t('p10.ai.hideRedacted') : t('p10.ai.showRedacted')}</button>
        {showRedacted && <div className="grid gap-2 sm:grid-cols-2 text-xs">
          <div><h4 className="label">{t('p10.ai.redacted')}</h4><pre data-testid="redacted" className="whitespace-pre-wrap rounded bg-surface-alt p-2">{redactedPreview(e.body, names)}</pre></div>
          <div><h4 className="label">{t('p10.ai.restored')}</h4><pre className="whitespace-pre-wrap rounded bg-surface-alt p-2">{e.body}</pre></div>
        </div>}
      </>}
      {s.payload && s.kind === 'classification' && <div className="grid gap-2 sm:grid-cols-3">
        <Field label={t('docs.category')} error={errs.category ? t('p10.v.required') : null}><input className="input" value={e.category} readOnly={!editing} onChange={(x) => setE({ ...e, category: x.target.value })} /></Field>
        <Field label={t('docs.fy')} error={errs.fy ? t('p10.v.fy') : null}><input className="input" placeholder="2025-26" value={e.fy} readOnly={!editing} onChange={(x) => setE({ ...e, fy: x.target.value })} /></Field>
        {typeof p.confidence === 'number' && <p className="self-end text-sm text-muted">{t('p10.ai.confidence', { pct: Math.round((p.confidence) * 100) })}</p>}
      </div>}
      {s.payload && s.kind === 'esign_request' && <pre className="whitespace-pre-wrap rounded bg-surface-alt p-2 text-xs">{JSON.stringify(s.payload, null, 2)}</pre>}
      {s.status !== 'pending' && <p className="text-sm text-muted">{t(`p10.sst.${s.status}` as 'p10.sst.approved')}{s.decidedAt ? ` · ${formatDateTime(s.decidedAt)}` : ''}</p>}
      {error && <p role="alert" data-testid="ai-error" className="rounded border border-overdue p-2 text-sm text-overdue">{t('p10.ai.notApplied')} {error}</p>}
      {acts.length > 0 && <div className="flex flex-wrap justify-end gap-2">
        {rejecting ? <>
          <Field label={t('p10.ai.rejectReason')}><input className="input" value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
          <button className="btn" type="button" onClick={() => setRejecting(false)}>{t('common.cancel')}</button>
          <button className="btn btn-danger" type="button" disabled={reject.isPending} onClick={() => { setError(null); reject.mutate(); }}>{t('p10.ai.confirmReject')}</button>
        </> : <>
          {acts.includes('reject') && <button className="btn" type="button" onClick={() => setRejecting(true)}>{t('p10.ai.reject')}</button>}
          {acts.includes('approve') && <button className="btn btn-primary" type="button" disabled={approve.isPending || Object.keys(errs).length > 0}
            onClick={() => { setError(null); approve.mutate(); }}>{t(`p10.ai.approve.${s.kind}` as 'p10.ai.approve.summary')}</button>}
        </>}
      </div>}
    </div>
  );
}

/** Generates a suggestion, then opens it for review (never applies anything on its own). */
function useGenerate(path: '/ai/summaries' | '/ai/draft-reply' | '/ai/classify', onOpen: (s: Suggestion) => void) {
  const err = useAiError();
  return useMutation({
    mutationFn: (b: Record<string, unknown>) => asFull<Suggestion>(api.POST(path, { body: body(b) })),
    onSuccess: onOpen,
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
}

function ReviewDialog({ s, title, onClose, clientNames }: { s: Suggestion; title: string; onClose(): void; clientNames?: string[] }) {
  return <Dialog title={title} onClose={onClose} wide><SuggestionReview s={s} onDone={onClose} clientNames={clientNames} /></Dialog>;
}

/** Client 360 timeline → "Summarise". */
export function SummariseButton({ clientId, clientName, noticeId }: { clientId: string; clientName: string; noticeId?: string }) {
  const t = useT();
  const on = useAiFeature('summarise');
  const [s, setS] = useState<Suggestion | null>(null);
  const m = useGenerate('/ai/summaries', setS);
  if (!on) return null;
  return <>
    <button type="button" className="btn" disabled={m.isPending} onClick={() => m.mutate({ clientId, ...(noticeId ? { noticeId } : {}) })}><Sparkles size={14} aria-hidden /> {m.isPending ? t('p10.ai.working') : t('p10.ai.summarise')}</button>
    {s && <ReviewDialog s={s} title={t('p10.ai.summaryOf', { name: clientName })} onClose={() => setS(null)} clientNames={[clientName]} />}
  </>;
}

/** Message / notice → "Draft reply": draft → edit → approve sends through the normal comm service (consent, caps, audit). */
export function DraftReplyButton({ clientId, clientName, messageId, noticeId, channel = 'email', compact }: { clientId: string; clientName: string; messageId?: string; noticeId?: string; channel?: CommChannel; compact?: boolean }) {
  const t = useT();
  const on = useAiFeature('draft_reply');
  const [s, setS] = useState<Suggestion | null>(null);
  const m = useGenerate('/ai/draft-reply', setS);
  if (!on) return null;
  return <>
    <button type="button" className={compact ? 'text-xs underline' : 'btn'} disabled={m.isPending} onClick={() => m.mutate({ clientId, channel, ...(messageId ? { messageId } : { noticeId }) })}>
      {!compact && <Sparkles size={14} aria-hidden />} {m.isPending ? t('p10.ai.working') : t('p10.ai.draftReply')}</button>
    {s && <ReviewDialog s={s} title={t('p10.ai.draftFor', { name: clientName })} onClose={() => setS(null)} clientNames={[clientName]} />}
  </>;
}

/** Document / portal upload → "Suggest category"; approving re-files the document. */
export function SuggestCategoryButton({ documentId, name }: { documentId: string; name: string }) {
  const t = useT();
  const on = useAiFeature('classify_upload');
  const [s, setS] = useState<Suggestion | null>(null);
  const m = useGenerate('/ai/classify', setS);
  if (!on) return null;
  return <>
    <button type="button" className="rounded p-1 text-muted hover:text-fg" aria-label={t('p10.ai.suggestCategoryFor', { name })} title={t('p10.ai.suggestCategory')} disabled={m.isPending}
      onClick={() => m.mutate({ documentId })}><Sparkles size={14} /></button>
    {s && <ReviewDialog s={s} title={t('p10.ai.categoryFor', { name })} onClose={() => setS(null)} />}
  </>;
}
