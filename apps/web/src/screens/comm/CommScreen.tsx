import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { as, body, CATEGORIES, CHANNELS, useCommError, useConsents, useLabel, useTemplates, type Channel, type InboxItem, type Template, type Usage } from './api';
import { BroadcastsView } from './BroadcastsView';
import { addressKey, consentFor, contactAddress, previewTemplate, ALLOWED_VARIABLES, type Contactish } from './logic';
import { CapMeter, ConsentBadge, NoAccess, StatusBadge } from './shared';

type View = 'broadcasts' | 'approvals' | 'templates' | 'consents' | 'inbox' | 'usage';

/** Communication hub: broadcasts, templates, consents, inbound triage and usage (M13). */
export function CommScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  if (!can('communication', 'view')) return <NoAccess />;
  const tabs: Array<[View, string]> = [
    ['broadcasts', t('p7.nav.broadcasts')],
    ...(can('communication', 'approve') ? [['approvals', t('p7.bc.approvals')] as [View, string]] : []),
    ['templates', t('p7.nav.templates')], ['consents', t('p7.nav.consents')],
    ...(can('communication', 'assign') ? [['inbox', t('nav.inbox')] as [View, string]] : []),
    ['usage', t('p7.nav.usage')],
  ];
  const view: View = tabs.find(([k]) => k === params[0])?.[0] ?? 'broadcasts';
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p7.nav.comm')}</h1>
      <Tabs<View> label={t('p7.nav.comm')} value={view} onChange={(v) => go(`comm/${v}`)} tabs={tabs} />
      {(view === 'broadcasts' || view === 'approvals') && <BroadcastsView approvals={view === 'approvals'} id={params[1]} />}
      {view === 'templates' && <TemplatesView />}
      {view === 'consents' && <ConsentsView />}
      {view === 'inbox' && <InboxView />}
      {view === 'usage' && <UsageView />}
    </div>
  );
}

// ---------- Inbox ----------

function InboxView() {
  const t = useT();
  const label = useLabel();
  const q = useQuery({ queryKey: ['comm', 'inbox'], queryFn: () => as<InboxItem[]>(api.GET('/comm/inbox')) });
  const [assigning, setAssigning] = useState<InboxItem | null>(null);
  const items = q.data ?? [];
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">{t('p7.inbox.hint')}</p>
      {!q.isLoading && !items.length && <p className="card p-4 text-muted">{t('p7.inbox.empty')}</p>}
      <ul className="card divide-y divide-border" aria-label={t('nav.inbox')}>
        {items.map((m) => (
          <li key={m.id} className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-x-2 text-xs text-muted"><span className="font-medium text-fg">{label('channel', m.channel)}</span>
                <span className="font-mono">{m.address}</span>{m.triage && <StatusBadge status={m.triage} family="triage" />}<time>{formatDateTime(m.occurredAt)}</time></div>
              {m.subject && <div className="font-medium">{m.subject}</div>}
              <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
            </div>
            <button className="btn" onClick={() => setAssigning(m)}>{t('p7.inbox.assign')}</button>
          </li>
        ))}
      </ul>
      {assigning && <AssignDialog item={assigning} onClose={() => setAssigning(null)} />}
    </div>
  );
}

export const useClientContacts = (clientId: string | null) => useQuery({
  queryKey: ['client', clientId], enabled: !!clientId, retry: false,
  queryFn: () => unwrap(api.GET('/clients/{id}', { params: { path: { id: clientId! } } })),
});

function AssignDialog({ item, onClose }: { item: InboxItem; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const [client, setClient] = useState<PickedClient | null>(null);
  const [contactId, setContactId] = useState('');
  const detail = useClientContacts(client?.id ?? null).data;
  const m = useMutation({
    mutationFn: () => as<{ assigned: number }>(api.POST('/comm/inbox/{id}/assign', { params: { path: { id: item.id } }, body: body({ clientId: client!.id, contactId: contactId || null }) })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['comm'] }); toast({ text: t('p7.inbox.assigned', { n: r.assigned }), tone: 'ok' }, 4000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p7.inbox.assignTitle', { address: item.address })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (client) m.mutate(); }}>
        <ClientPicker label={t('p6.f.client')} value={client} onChange={(c) => { setClient(c); setContactId(''); }} />
        {detail && <Field label={t('p7.f.contact')}><select className="input" value={contactId} onChange={(e) => setContactId(e.target.value)}>
          <option value="">{t('p7.inbox.noContact')}</option>
          {detail.contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
        <p className="text-xs text-muted">{t('p7.inbox.alsoMoves')}</p>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!client || m.isPending}>{t('p7.inbox.assign')}</button></div>
      </form>
    </Dialog>
  );
}

// ---------- Templates ----------

function TemplatesView() {
  const t = useT();
  const can = useCan();
  const label = useLabel();
  const qc = useQueryClient();
  const err = useCommError();
  const q = useTemplates();
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [rejecting, setRejecting] = useState<Template | null>(null);
  const done = (text: string) => { void qc.invalidateQueries({ queryKey: ['comm', 'templates'] }); toast({ text, tone: 'ok' }, 3000); };
  const submit = useMutation({
    mutationFn: (id: string) => as<{ status: string; providerRef: string | null }>(api.POST('/comm/templates/{id}/submit', { params: { path: { id } } })),
    onSuccess: () => done(t('p7.tpl.submitted')), onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; reason?: string }) => as(api.POST('/comm/templates/{id}/decide', { params: { path: { id: v.id } }, body: body({ approve: v.approve, reason: v.reason ?? null }) })),
    onSuccess: (_r, v) => { done(v.approve ? t('p7.tpl.approved') : t('p7.tpl.rejected')); setRejecting(null); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2"><p className="text-sm text-muted">{t('p7.tpl.hint')}</p>
        {can('communication', 'create') && <button className="btn btn-primary ml-auto" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('p7.tpl.new')}</button>}</div>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p7.nav.templates')}>
        <thead><tr><th>{t('p7.f.name')}</th><th>{t('p7.f.channel')}</th><th>{t('p7.f.category')}</th><th>{t('p6.f.status')}</th><th /></tr></thead>
        <tbody>{(q.data ?? []).map((x) => (
          <tr key={x.id}>
            <td><span className="font-mono">{x.name}</span> <span className="text-xs text-muted">{x.language}</span>{x.sensitive && <span className="ml-1 text-xs text-overdue">{t('p7.tpl.sensitive')}</span>}</td>
            <td>{label('channel', x.channel)}</td><td>{label('category', x.category)}</td>
            <td><StatusBadge status={x.status} family="tstatus" />
              {x.channel === 'whatsapp' && x.providerRef && <span className="ml-1 text-xs text-muted" title={x.providerRef}>{x.providerRef.startsWith('mock-') ? t('p7.tpl.mockProvider') : x.providerRef}</span>}
              {x.rejectionReason && <span className="block text-xs text-overdue">{x.rejectionReason}</span>}</td>
            <td className="space-x-1 whitespace-nowrap text-right">
              {can('communication', 'edit') && <button className="btn" onClick={() => setEditing(x)}>{t('p6.edit')}</button>}
              {can('communication', 'edit') && (x.status === 'draft' || x.status === 'rejected') && <button className="btn" onClick={() => submit.mutate(x.id)}>{t('p7.tpl.submit')}</button>}
              {can('communication', 'approve') && x.status === 'submitted' && <>
                <button className="btn" onClick={() => decide.mutate({ id: x.id, approve: true })}>{x.channel === 'whatsapp' ? t('p7.tpl.mockApprove') : t('p6.approve')}</button>
                <button className="btn btn-danger" onClick={() => setRejecting(x)}>{t('p6.reject')}</button></>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      {editing && <TemplateDialog tpl={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {rejecting && <RejectDialog onClose={() => setRejecting(null)} onReject={(reason) => decide.mutate({ id: rejecting.id, approve: false, reason })} />}
    </div>
  );
}

function RejectDialog({ onClose, onReject }: { onClose(): void; onReject(reason: string): void }) {
  const t = useT();
  const [reason, setReason] = useState('');
  return (
    <Dialog title={t('p7.tpl.rejectTitle')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onReject(reason.trim()); }}>
        <Field label={t('p6.f.reason')}><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-danger" disabled={!reason.trim()}>{t('p6.reject')}</button></div>
      </form>
    </Dialog>
  );
}

export function useIssueText() {
  const t = useT();
  return (i: { code: string; name?: string }) => t(`p7.tpl.issue.${i.code}` as 'p7.tpl.issue.malformed_placeholder', { name: i.name ?? '' });
}

function TemplateDialog({ tpl, onClose }: { tpl: Template | null; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const label = useLabel();
  const issueText = useIssueText();
  const [name, setName] = useState(tpl?.name ?? '');
  const [channel, setChannel] = useState<Channel>(tpl?.channel ?? 'email');
  const [category, setCategory] = useState(tpl?.category ?? 'transactional');
  const [language, setLanguage] = useState(tpl?.language ?? 'en');
  const [subject, setSubject] = useState(tpl?.subject ?? '');
  const [text, setText] = useState(tpl?.body ?? '');
  const [sensitive, setSensitive] = useState(tpl?.sensitive ?? false);
  const [dlt, setDlt] = useState(tpl?.dltTemplateId ?? '');
  const [serverIssues, setServerIssues] = useState<string | null>(null);
  const p = previewTemplate({ channel, subject: channel === 'email' ? subject : null, body: text });
  const badName = !tpl && !/^[a-z0-9_]{2,60}$/.test(name);
  const badDlt = channel === 'sms' && dlt !== '' && !/^\d{10,25}$/.test(dlt);
  const save = useMutation({
    mutationFn: () => {
      const common = { category, language, subject: channel === 'email' ? subject.trim() : null, body: text.trim(), sensitive, dltTemplateId: channel === 'sms' ? dlt || null : null };
      return tpl ? as(api.PATCH('/comm/templates/{id}', { params: { path: { id: tpl.id } }, body: body(common) })) : as(api.POST('/comm/templates', { body: body({ name, channel, ...common }) }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['comm', 'templates'] }); toast({ text: t('p6.saved'), tone: 'ok' }, 3000); onClose(); },
    onError: (e) => setServerIssues(err(e)),
  });
  const changesResetApproval = !!tpl && tpl.status !== 'draft' && (text !== tpl.body || (subject || null) !== tpl.subject || category !== tpl.category);
  return (
    <Dialog title={tpl ? t('p7.tpl.edit', { name: tpl.name }) : t('p7.tpl.new')} onClose={onClose} wide>
      <form className="grid gap-3 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); setServerIssues(null); if (!p.issues.length && !badName && !badDlt) save.mutate(); }}>
        <div className="space-y-3">
          <Field label={t('p7.f.name')} hint={t('p7.tpl.nameHint')} error={name && badName ? t('p7.tpl.badName') : null}>
            <input className="input font-mono" value={name} disabled={!!tpl} onChange={(e) => setName(e.target.value)} required /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label={t('p7.f.channel')}><select className="input" value={channel} disabled={!!tpl} onChange={(e) => setChannel(e.target.value as Channel)}>
              {CHANNELS.map((c) => <option key={c} value={c}>{label('channel', c)}</option>)}</select></Field>
            <Field label={t('p7.f.category')}><select className="input" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{label('category', c)}</option>)}</select></Field>
            <Field label={t('p7.f.language')}><input className="input" value={language} onChange={(e) => setLanguage(e.target.value)} /></Field>
          </div>
          {channel === 'email' && <Field label={t('p7.f.subject')}><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
          <Field label={t('p7.f.body')} hint={t('p7.tpl.vars', { vars: ALLOWED_VARIABLES.map((v) => `{{${v}}}`).join(' ') })}>
            <textarea className="input min-h-32 font-mono" value={text} onChange={(e) => setText(e.target.value)} /></Field>
          {channel === 'sms' && <Field label={t('p7.f.dlt')} error={badDlt ? t('p7.tpl.badDlt') : null}><input className="input" value={dlt} onChange={(e) => setDlt(e.target.value)} /></Field>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} /> {t('p7.tpl.sensitiveLabel')}</label>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('p7.tpl.preview')}</h3>
          <div className="rounded bg-surface-alt p-3 text-sm" data-testid="tpl-preview">
            {p.subject && <div className="font-medium">{p.subject}</div>}
            <p className="whitespace-pre-wrap">{p.text}</p>
          </div>
          <p className="text-xs text-muted">{t('p7.tpl.sampleNote')}</p>
          {p.issues.length > 0 && <ul role="alert" className="space-y-0.5 text-sm text-overdue" data-testid="tpl-issues">{p.issues.map((i) => <li key={`${i.code}:${i.name ?? ''}`}>{issueText(i)}</li>)}</ul>}
          {changesResetApproval && <p className="text-sm text-due-soon">{t('p7.tpl.resetWarning')}</p>}
          {serverIssues && <p role="alert" className="text-sm text-overdue">{serverIssues}</p>}
        </div>
        <div className="flex justify-end gap-2 md:col-span-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={p.issues.length > 0 || badName || badDlt || save.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

// ---------- Consents ----------

const SOURCES = ['verbal', 'written', 'form', 'email', 'whatsapp', 'other'] as const;

function ConsentsView() {
  const t = useT();
  const can = useCan();
  const label = useLabel();
  const [client, setClient] = useState<PickedClient | null>(null);
  const detail = useClientContacts(client?.id ?? null).data;
  const consents = useConsents(client?.id ?? null).data ?? [];
  const [recording, setRecording] = useState<{ contact: Contactish | null; channel: Channel; address: string } | null>(null);
  const rows: Array<{ contact: Contactish | null; name: string }> = detail ? [...detail.contacts.map((c) => ({ contact: c as Contactish, name: c.name })), { contact: null, name: t('p7.compose.clientItself') }] : [];
  return (
    <div className="space-y-3">
      <div className="max-w-md"><ClientPicker label={t('p6.f.client')} value={client} onChange={setClient} /></div>
      {detail && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p7.nav.consents')}>
        <thead><tr><th>{t('p7.f.contact')}</th>{CHANNELS.map((c) => <th key={c}>{label('channel', c)}</th>)}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.contact?.id ?? 'client'}><td>{r.name}</td>
            {CHANNELS.map((ch) => {
              const addr = contactAddress(r.contact ?? { id: '', name: '', email: detail.email, phone: detail.phone }, ch);
              const st = consentFor(consents, ch, addr);
              const rec = consents.find((x) => x.channel === ch && addressKey(ch, x.address) === addressKey(ch, addr));
              return (
                <td key={ch} data-testid={`consent-${r.contact?.id ?? 'client'}-${ch}`} className={st === 'opted_out' ? 'bg-surface-alt' : ''}>
                  <div className="font-mono text-xs">{addr ?? '—'}</div>
                  <ConsentBadge state={st} />
                  {rec && <div className="text-xs text-muted">{st === 'opted_out' ? t('p7.consent.outVia', { source: rec.optedOutSource ?? '', date: rec.optedOutAt ? formatDate(rec.optedOutAt) : '' }) : t('p7.consent.inVia', { source: rec.optedInSource ?? '', date: rec.optedInAt ? formatDate(rec.optedInAt) : '' })}</div>}
                  {addr && can('communication', 'edit') && <button className="mt-1 text-xs text-primary underline" onClick={() => setRecording({ contact: r.contact, channel: ch, address: addr })}>{t('p7.consent.record')}</button>}
                </td>
              );
            })}</tr>
        ))}</tbody>
      </table></div>}
      {recording && client && <ConsentDialog clientId={client.id} {...recording} onClose={() => setRecording(null)} />}
    </div>
  );
}

function ConsentDialog({ clientId, contact, channel, address, onClose }: { clientId: string; contact: Contactish | null; channel: Channel; address: string; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const label = useLabel();
  const [status, setStatus] = useState<'opted_in' | 'opted_out'>('opted_in');
  const [source, setSource] = useState<(typeof SOURCES)[number]>('written');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => as(api.POST('/comm/consents', { body: body({ clientId, channel, contactId: contact?.id ?? null, address, status, source, note: note.trim() || null }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['comm', 'consents'] }); toast({ text: t('p7.consent.saved'), tone: 'ok' }, 3000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p7.consent.recordFor', { channel: label('channel', channel), address })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div role="radiogroup" aria-label={t('p6.f.status')} className="flex gap-4">
          <label className="flex items-center gap-2"><input type="radio" checked={status === 'opted_in'} onChange={() => setStatus('opted_in')} /> {t('p7.consent.opted_in')}</label>
          <label className="flex items-center gap-2"><input type="radio" checked={status === 'opted_out'} onChange={() => setStatus('opted_out')} /> {t('p7.consent.opted_out')}</label>
        </div>
        <Field label={t('p7.consent.source')}><select className="input" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
          {SOURCES.map((s) => <option key={s} value={s}>{label('source', s)}</option>)}</select></Field>
        <Field label={t('p6.f.note')}><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

// ---------- Usage ----------

function UsageView() {
  const t = useT();
  const label = useLabel();
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const q = useQuery({ queryKey: ['comm', 'usage', month], queryFn: () => as<Usage>(api.GET('/comm/usage', { params: { query: { month } } })) });
  const u = q.data;
  return (
    <div className="space-y-3">
      <Field label={t('p7.usage.month')}><input type="month" className="input w-48" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
      {u && <>
        <div className="card p-3"><div className="text-sm text-muted">{t('p7.usage.total')}</div><div className="text-2xl font-semibold tabular-nums" data-testid="usage-total">{formatINR(u.totalPaise)}</div>
          <div className="text-xs text-muted">{t('p7.usage.capMode', { mode: label('capMode', u.capMode) })}</div></div>
        <ul className="grid gap-2 md:grid-cols-3">{u.byChannel.map((c) => (
          <li key={c.channel} className="card space-y-1 p-3" data-testid={`usage-${c.channel}`}>
            <CapMeter label={label('channel', c.channel)} usedPaise={c.costPaise} capPaise={c.capPaise} />
            <div className="text-xs text-muted">{t('p7.usage.messages', { n: c.messages })}{c.capWarnings ? ` · ${t('p7.usage.warnings', { n: c.capWarnings })}` : ''}</div>
            {c.overCap && <div className="text-xs text-overdue">{t('p7.usage.overCap')}</div>}
          </li>
        ))}</ul>
      </>}
    </div>
  );
}
