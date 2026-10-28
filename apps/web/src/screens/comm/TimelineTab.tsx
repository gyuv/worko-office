import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { FileText, Mail, MessageCircle, MessageSquare, Phone, Receipt, StickyNote, CheckSquare, Send } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api } from '../../lib/session';
import { useUsers } from '../tasks/shared';
import { as, body, CHANNELS, fetchTimeline, useCommError, useCommSettings, useConsents, useLabel, useTemplates, type Channel } from './api';
import { consentBlock, consentFor, contactAddress, groupTimeline, timelineFamily, userVars, type Contactish, type TimelineItem } from './logic';
import { ConsentBadge } from './shared';

export type TimelineClient = { id: string; name: string; email: string | null; phone: string | null; contacts: Contactish[] };

const ICON = { email: Mail, whatsapp: MessageCircle, sms: MessageSquare, note: StickyNote, call: Phone, document: FileText, invoice: Receipt, task: CheckSquare } as const;
const FILTERS = ['', 'email', 'whatsapp', 'sms', 'note', 'call', 'events'] as const;

/** Client 360 → Timeline: one merged, paged history plus composer and call/note logging (D102). */
export function TimelineTab({ client }: { client: TimelineClient }) {
  const t = useT();
  const can = useCan();
  const label = useLabel();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('');
  const [composing, setComposing] = useState(false);
  const [logging, setLogging] = useState<'note' | 'call' | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['comm', 'timeline', client.id, filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchTimeline(client.id, pageParam, filter || undefined),
    getNextPageParam: (p) => p.nextBefore ?? undefined,
  });
  const groups = groupTimeline(q.data?.pages ?? []);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('p7.tl.filter')}>
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            {FILTERS.map((f) => <option key={f} value={f}>{f ? label('tl.kind', f) : t('p7.tl.all')}</option>)}
          </select>
        </Field>
        <div className="ml-auto flex gap-2">
          {can('communication', 'create') && <>
            <button className="btn btn-primary" onClick={() => setComposing(true)}><Send size={14} aria-hidden /> {t('p7.tl.compose')}</button>
            <button className="btn" onClick={() => setLogging('call')}><Phone size={14} aria-hidden /> {t('p7.tl.logCall')}</button>
            <button className="btn" onClick={() => setLogging('note')}><StickyNote size={14} aria-hidden /> {t('p7.tl.addNote')}</button>
          </>}
        </div>
      </div>
      {q.isLoading && <p className="text-muted">{t('common.loading')}</p>}
      {q.isError && <p role="alert" className="text-overdue">{t('common.error')}</p>}
      {!q.isLoading && !groups.length && <p className="card p-4 text-muted">{t('p7.tl.empty')}</p>}
      <ol className="space-y-3" aria-label={t('p7.tl.title')}>
        {groups.map((g) => (
          <li key={g.day}>
            <h3 className="mb-1 text-xs font-medium uppercase text-muted">{formatDate(`${g.day}T12:00:00+05:30`)}</h3>
            <ul className="card divide-y divide-border">{g.items.map((i) => <Entry key={`${i.kind}:${i.id}`} i={i} />)}</ul>
          </li>
        ))}
      </ol>
      {q.hasNextPage && <button className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('p7.tl.older')}</button>}
      {composing && <ComposeDialog client={client} onClose={() => setComposing(false)} />}
      {logging && <LogDialog clientId={client.id} kind={logging} onClose={() => setLogging(null)} />}
    </div>
  );
}

/** Email HTML only ever renders inside a fully sandboxed iframe (no scripts, no same-origin); everything else is escaped text. */
export function MessageBody({ body: text, html }: { body: string; html: boolean }) {
  const t = useT();
  if (!html) return <p className="whitespace-pre-wrap break-words text-sm">{text}</p>;
  return <iframe title={t('p7.tl.emailBody')} sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${text}`} className="h-40 w-full rounded border border-border bg-surface" />;
}

function Entry({ i }: { i: TimelineItem }) {
  const t = useT();
  const label = useLabel();
  const { name } = useUsers();
  const fam = timelineFamily(i);
  const Icon = ICON[fam as keyof typeof ICON] ?? StickyNote;
  const dir = i.direction === 'in' ? t('p7.tl.in') : i.direction === 'out' ? t('p7.tl.out') : null;
  return (
    <li className="flex gap-3 p-3" data-testid={`tl-${i.id}`}>
      <Icon size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="font-medium text-fg">{label('tl.kind', fam)}</span>
          {dir && <span>{dir}</span>}
          {i.address && <span className="font-mono">{i.address}</span>}
          {i.status && i.kind === 'message' && i.status !== 'logged' && <span className={`rounded bg-surface-alt px-1.5 ${i.status === 'failed' || i.status === 'cancelled' ? 'text-overdue' : ''}`}>{label('status', i.status)}</span>}
          {i.callMinutes !== null && <span>{t('p7.tl.minutes', { n: i.callMinutes })}</span>}
          {i.amountPaise !== null && <span>{formatINR(i.amountPaise)}</span>}
          {i.broadcastId && <span>{t('p7.tl.viaBroadcast')}</span>}
          {i.by && <span>{name(i.by)}</span>}
          <time className="ml-auto" dateTime={i.at}>{formatDateTime(i.at)}</time>
        </div>
        {i.title && <div className="font-medium">{i.title}</div>}
        {i.body && i.kind === 'message' && <MessageBody body={i.body} html={i.channel === 'email' && i.format === 'html'} />}
        {i.body && i.kind !== 'message' && <p className="text-xs text-muted">{i.body}</p>}
      </div>
    </li>
  );
}

/** Composer: channel × recipient (with consent), template (with variables + server preview) or free text. Refusals are shown inline. */
export function ComposeDialog({ client, onClose }: { client: TimelineClient; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const label = useLabel();
  const settings = useCommSettings().data;
  const consents = useConsents(client.id).data ?? [];
  const templates = useTemplates().data ?? [];
  const [channel, setChannel] = useState<Channel>('email');
  const [contactId, setContactId] = useState<string>(client.contacts[0]?.id ?? '');
  const [mode, setMode] = useState<'template' | 'free'>('template');
  const [templateId, setTemplateId] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const contact = client.contacts.find((c) => c.id === contactId) ?? null;
  const address = contact ? contactAddress(contact, channel) ?? contactAddress({ id: '', name: '', email: client.email, phone: client.phone }, channel)
    : contactAddress({ id: '', name: '', email: client.email, phone: client.phone }, channel);
  const state = consentFor(consents, channel, address);
  const usable = templates.filter((x) => x.channel === channel && x.status === 'approved');
  const tpl = usable.find((x) => x.id === templateId) ?? null;
  const category = tpl?.category ?? 'transactional';
  const warn = settings ? consentBlock(state, category, settings.consent) : null;
  const needed = userVars(tpl?.variables);
  const preview = useQuery({
    queryKey: ['comm', 'render', tpl?.id, client.id, vars], enabled: !!tpl && mode === 'template',
    queryFn: () => as<{ subject: string | null; body: string; missing: string[] }>(api.POST('/comm/templates/{id}/render', { params: { path: { id: tpl!.id } }, body: body({ clientId: client.id, vars }) })),
  });
  const send = useMutation({
    mutationFn: () => as<{ id: string; status: string; sendAt: string; costPaise: number; capWarning: boolean }>(api.POST('/comm/messages', {
      body: body({ clientId: client.id, channel, contactId: contactId || null, ...(mode === 'template' ? { templateId: tpl!.id, vars } : { subject: channel === 'email' ? subject : null, body: text }) }),
    })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['comm', 'timeline', client.id] });
      void qc.invalidateQueries({ queryKey: ['comm', 'usage'] });
      toast({ text: r.status === 'queued' ? t('p7.compose.queued', { at: formatDateTime(r.sendAt) }) : t('p7.compose.sent'), tone: 'ok' }, 4000);
      if (r.capWarning) toast({ text: t('p7.compose.capWarning'), tone: 'error' });
      onClose();
    },
    onError: (e) => setRefusal(err(e)),
  });
  const canSend = !!address && (mode === 'template' ? !!tpl && !(preview.data?.missing.length) : !!text.trim() && (channel !== 'email' || !!subject.trim()));
  return (
    <Dialog title={t('p7.compose.title', { name: client.name })} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setRefusal(null); if (canSend) send.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('p7.f.channel')}><select className="input" value={channel} onChange={(e) => { setChannel(e.target.value as Channel); setTemplateId(''); setRefusal(null); }}>
            {CHANNELS.map((c) => <option key={c} value={c}>{label('channel', c)}</option>)}</select></Field>
          <Field label={t('p7.f.recipient')}><select className="input" value={contactId} onChange={(e) => { setContactId(e.target.value); setRefusal(null); }}>
            {client.contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="">{t('p7.compose.clientItself')}</option></select></Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="compose-consent">
          <span className="font-mono">{address ?? t('p7.consent.noAddress')}</span>
          <ConsentBadge state={state} />
          {warn && <span className="text-overdue">{t(`p7.err.${warn}`)}</span>}
        </div>
        <div role="radiogroup" aria-label={t('p7.compose.mode')} className="flex gap-4">
          <label className="flex items-center gap-2"><input type="radio" checked={mode === 'template'} onChange={() => setMode('template')} /> {t('p7.compose.useTemplate')}</label>
          <label className="flex items-center gap-2"><input type="radio" checked={mode === 'free'} onChange={() => setMode('free')} /> {t('p7.compose.freeText')}</label>
        </div>
        {mode === 'template' ? <>
          <Field label={t('p7.f.template')} hint={channel === 'whatsapp' ? t('p7.compose.waApprovedOnly') : t('p7.compose.approvedOnly')}>
            <select className="input" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVars({}); }}>
              <option value="">{t('p7.compose.pickTemplate')}</option>
              {usable.map((x) => <option key={x.id} value={x.id}>{x.name} · {label('category', x.category)}</option>)}
            </select></Field>
          {needed.map((v) => (
            <Field key={v} label={v}><input className="input" value={vars[v] ?? ''} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} /></Field>
          ))}
          {tpl && <div className="rounded bg-surface-alt p-2 text-sm" data-testid="compose-preview">
            {preview.data?.subject && <div className="font-medium">{preview.data.subject}</div>}
            <MessageBody body={preview.data?.body ?? ''} html={channel === 'email'} />
            {!!preview.data?.missing.length && <p className="text-overdue">{t('p7.compose.missing', { vars: preview.data.missing.join(', ') })}</p>}
          </div>}
        </> : <>
          {channel === 'email' && <Field label={t('p7.f.subject')}><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
          <Field label={t('p7.f.message')} hint={channel === 'whatsapp' ? t('p7.compose.waWindow') : t('p7.compose.freeTextTxn')}>
            <textarea className="input min-h-24" value={text} onChange={(e) => setText(e.target.value)} /></Field>
        </>}
        {refusal && <p role="alert" className="rounded border border-overdue p-2 text-sm text-overdue" data-testid="compose-refusal">{t('p7.compose.notSent')} {refusal}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!canSend || send.isPending}>{t('p7.compose.send')}</button></div>
      </form>
    </Dialog>
  );
}

function LogDialog({ clientId, kind, onClose }: { clientId: string; kind: 'note' | 'call'; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [minutes, setMinutes] = useState('');
  const m = useMutation({
    mutationFn: () => as<{ id: string }>(api.POST('/clients/{id}/timeline', { params: { path: { id: clientId } }, body: body({
      channel: kind, body: text.trim(), subject: subject.trim() || null, ...(kind === 'call' ? { direction, callMinutes: minutes ? Number(minutes) : null } : {}),
    }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['comm', 'timeline', clientId] }); toast({ text: t('p7.tl.logged'), tone: 'ok' }, 3000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const badMin = minutes !== '' && !/^\d{1,4}$/.test(minutes);
  return (
    <Dialog title={kind === 'call' ? t('p7.tl.logCall') : t('p7.tl.addNote')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (text.trim() && !badMin) m.mutate(); }}>
        <Field label={t('p7.f.subject')}><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        {kind === 'call' && <div className="grid grid-cols-2 gap-3">
          <Field label={t('p7.tl.direction')}><select className="input" value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
            <option value="out">{t('p7.tl.outgoing')}</option><option value="in">{t('p7.tl.incoming')}</option></select></Field>
          <Field label={t('p7.tl.callMinutes')} error={badMin ? t('p7.tl.badMinutes') : null}><input className="input" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
        </div>}
        <Field label={kind === 'call' ? t('p7.tl.callNotes') : t('p7.tl.note')}><textarea className="input min-h-24" value={text} onChange={(e) => setText(e.target.value)} required /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!text.trim() || badMin || m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}
