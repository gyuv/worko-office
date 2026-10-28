import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ENTITY_TYPES, formatINR } from '@worko/domain';
import { formatDateTime } from '@worko/i18n';
import { ArrowLeft, Download, Plus } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { fetchBlob, saveBlob } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { isUuid, useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { useEntityLabel } from '../clients/labels';
import { useServiceTypes, useUsers } from '../tasks/shared';
import { as, body, CHANNELS, useCommError, useLabel, useTemplates, type Broadcast, type BroadcastFilters, type Channel, type Recipient } from './api';
import { fromLocalInput, previewTotals, progressPct, userVars, type BroadcastPreview } from './logic';
import { StatusBadge } from './shared';

const useBroadcasts = () => useQuery({ queryKey: ['comm', 'broadcasts'], queryFn: () => as<Broadcast[]>(api.GET('/comm/broadcasts')) });

export function BroadcastsView({ approvals, id }: { approvals: boolean; id?: string }) {
  const t = useT();
  const can = useCan();
  const go = useRoute((s) => s.go);
  const [wizard, setWizard] = useState(false);
  const q = useBroadcasts();
  if (isUuid(id)) return <BroadcastDetail id={id} />;
  const items = (q.data ?? []).filter((b) => !approvals || b.status === 'pending_approval');
  return (
    <div className="space-y-2">
      {!approvals && can('communication', 'create') && <div className="flex"><button className="btn btn-primary ml-auto" onClick={() => setWizard(true)}><Plus size={14} aria-hidden /> {t('p7.bc.new')}</button></div>}
      {approvals && <p className="text-sm text-muted">{t('p7.bc.approvalsHint')}</p>}
      {!q.isLoading && !items.length && <p className="card p-4 text-muted">{approvals ? t('p6.nothingPending') : t('p7.bc.empty')}</p>}
      {items.length > 0 && <div className="card overflow-auto"><table className="table w-full" aria-label={approvals ? t('p7.bc.approvals') : t('p7.nav.broadcasts')}>
        <thead><tr><th>{t('p7.f.name')}</th><th>{t('p7.f.channel')}</th><th>{t('p6.f.status')}</th><th>{t('p7.bc.scheduled')}</th><th className="text-right">{t('p7.bc.eligible')}</th><th className="text-right">{t('p7.bc.cost')}</th></tr></thead>
        <tbody>{items.map((b) => (
          <tr key={b.id} className="cursor-pointer hover:bg-surface-alt" onClick={() => go(`comm/${approvals ? 'approvals' : 'broadcasts'}/${b.id}`)}>
            <td><a href={`#/comm/${approvals ? 'approvals' : 'broadcasts'}/${b.id}`} className="font-medium">{b.name}</a></td>
            <td><ChannelLabel c={b.channel} /></td><td><StatusBadge status={b.status} family="bstatus" /></td>
            <td>{b.scheduledAt ? formatDateTime(b.scheduledAt) : '—'}</td>
            <td className="text-right tabular-nums">{typeof b.estimate?.eligible === 'number' ? b.estimate.eligible : '—'}</td>
            <td className="text-right tabular-nums">{b.spentPaise ? formatINR(b.spentPaise) : typeof b.estimate?.costPaise === 'number' ? `~${formatINR(b.estimate.costPaise)}` : '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>}
      {wizard && <BroadcastWizard onClose={() => setWizard(false)} onDone={(bid) => { setWizard(false); go(`comm/broadcasts/${bid}`); }} />}
    </div>
  );
}

function ChannelLabel({ c }: { c: string }) { const label = useLabel(); return <>{label('channel', c)}</>; }

/** Dry-run summary of a preview/estimate. */
export function PreviewSummary({ p }: { p: BroadcastPreview }) {
  const t = useT();
  const s = previewTotals(p);
  return (
    <div className="space-y-2" data-testid="bc-preview">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="card p-2"><dt className="text-xs text-muted">{t('p7.bc.audience')}</dt><dd className="text-lg font-semibold tabular-nums" data-testid="bc-audience">{p.audience}</dd></div>
        {s.rows.map(([k, n]) => (
          <div key={k} className="card p-2"><dt className="text-xs text-muted">{t(`p7.bc.${k}` as 'p7.bc.eligible')}</dt>
            <dd className={`text-lg font-semibold tabular-nums ${k === 'eligible' ? 'text-done' : n ? 'text-overdue' : ''}`} data-testid={`bc-${k}`}>{n}</dd></div>
        ))}
        <div className="card p-2"><dt className="text-xs text-muted">{t('p7.bc.estCost')}</dt><dd className="text-lg font-semibold tabular-nums" data-testid="bc-cost">{formatINR(s.costPaise)}</dd>
          <dd className="text-xs text-muted">{t('p7.bc.perMessage', { amount: formatINR(p.unitPaise) })}</dd></div>
      </dl>
      {p.capWarning && <p className="text-sm text-due-soon">{t('p7.bc.capWarning')}</p>}
      {p.needsApproval && <p className="text-sm text-due-soon" data-testid="bc-needs-approval">{t('p7.bc.needsApproval')}</p>}
      {!s.canSend && <p className="text-sm text-overdue">{t('p7.err.no_recipients')}</p>}
      {p.sample && p.sample.length > 0 && <details><summary className="cursor-pointer text-sm">{t('p7.bc.sample', { n: p.sample.length })}</summary>
        <ul className="mt-1 text-sm">{p.sample.map((r) => <li key={r.clientId + (r.address ?? '')} className="flex gap-2"><span className="flex-1">{r.clientName}</span><span className="font-mono text-xs">{r.address ?? '—'}</span><StatusBadge status={r.status} family="rstatus" /></li>)}</ul></details>}
    </div>
  );
}

type Step = 'audience' | 'message' | 'schedule' | 'preview';

function BroadcastWizard({ onClose, onDone }: { onClose(): void; onDone(id: string): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const label = useLabel();
  const entity = useEntityLabel();
  const groups = useQuery({ queryKey: ['client-groups'], queryFn: () => unwrap(api.GET('/client-groups')) }).data ?? [];
  const services = useServiceTypes().data ?? [];
  const templates = useTemplates().data ?? [];
  const [step, setStep] = useState<Step>('audience');
  const [name, setName] = useState('');
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [serviceTypeIds, setServiceTypeIds] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [channel, setChannel] = useState<Channel>('email');
  const [templateId, setTemplateId] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [created, setCreated] = useState<{ id: string; preview: BroadcastPreview } | null>(null);
  const approved = templates.filter((x) => x.channel === channel && x.status === 'approved');
  const tpl = approved.find((x) => x.id === templateId);
  const needed = userVars(tpl?.variables);
  const scheduledAt = when === 'later' ? fromLocalInput(at) : null;
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const filters: BroadcastFilters = {
    ...(entityTypes.length ? { entityTypes } : {}), ...(groupIds.length ? { groupIds } : {}), ...(serviceTypeIds.length ? { serviceTypeIds } : {}),
    ...(tags.trim() ? { tags: tags.split(',').map((x) => x.trim()).filter(Boolean) } : {}), ...(includeInactive ? { includeInactive } : {}),
  };
  const create = useMutation({
    mutationFn: async () => {
      const { id } = await as<{ id: string }>(api.POST('/comm/broadcasts', { body: body({ name: name.trim(), channel, templateId, filters, variables: vars, scheduledAt }) }));
      const preview = await as<BroadcastPreview>(api.POST('/comm/broadcasts/{id}/preview', { params: { path: { id } } }));
      return { id, preview };
    },
    onSuccess: (r) => { setCreated(r); setStep('preview'); void qc.invalidateQueries({ queryKey: ['comm', 'broadcasts'] }); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const send = useMutation({
    mutationFn: () => as<{ status: string; scheduledAt: string }>(api.POST('/comm/broadcasts/{id}/send', { params: { path: { id: created!.id } }, body: body({ scheduledAt }) })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['comm', 'broadcasts'] });
      toast({ text: r.status === 'pending_approval' ? t('p7.bc.sentForApproval') : t('p7.bc.scheduledAt', { at: formatDateTime(r.scheduledAt) }), tone: 'ok' }, 5000);
      onDone(created!.id);
    },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const badWhen = when === 'later' && (!scheduledAt);
  const steps: Step[] = ['audience', 'message', 'schedule', 'preview'];
  return (
    <Dialog title={t('p7.bc.new')} onClose={onClose} wide>
      <ol className="mb-3 flex gap-2 text-xs" aria-label={t('p7.bc.steps')}>{steps.map((s, k) => <li key={s} aria-current={s === step ? 'step' : undefined} className={s === step ? 'font-semibold' : 'text-muted'}>{k + 1}. {t(`p7.bc.step.${s}`)}</li>)}</ol>
      {step === 'audience' && <div className="space-y-3">
        <Field label={t('p7.f.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <fieldset><legend className="label">{t('p7.bc.entityTypes')}</legend><div className="flex flex-wrap gap-x-3 gap-y-1">
          {ENTITY_TYPES.map((e) => <label key={e} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={entityTypes.includes(e)} onChange={() => toggle(entityTypes, setEntityTypes, e)} /> {entity(e)}</label>)}</div></fieldset>
        {groups.length > 0 && <fieldset><legend className="label">{t('p7.bc.groups')}</legend><div className="flex flex-wrap gap-x-3">
          {groups.map((g) => <label key={g.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => toggle(groupIds, setGroupIds, g.id)} /> {g.name}</label>)}</div></fieldset>}
        {services.length > 0 && <fieldset><legend className="label">{t('p7.bc.services')}</legend><div className="flex flex-wrap gap-x-3">
          {services.map((s) => <label key={s.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={serviceTypeIds.includes(s.id)} onChange={() => toggle(serviceTypeIds, setServiceTypeIds, s.id)} /> {s.name}</label>)}</div></fieldset>}
        <Field label={t('p7.bc.tags')} hint={t('p7.bc.tagsHint')}><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> {t('p7.bc.includeInactive')}</label>
        <p className="text-xs text-muted">{t('p7.bc.audienceNote')}</p>
      </div>}
      {step === 'message' && <div className="space-y-3">
        <Field label={t('p7.f.channel')}><select className="input" value={channel} onChange={(e) => { setChannel(e.target.value as Channel); setTemplateId(''); }}>
          {CHANNELS.map((c) => <option key={c} value={c}>{label('channel', c)}</option>)}</select></Field>
        <Field label={t('p7.f.template')} hint={t('p7.bc.approvedOnly')}><select className="input" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVars({}); }}>
          <option value="">{t('p7.compose.pickTemplate')}</option>
          {approved.map((x) => <option key={x.id} value={x.id}>{x.name} · {label('category', x.category)}</option>)}</select></Field>
        {tpl && <div className="rounded bg-surface-alt p-2 text-sm"><p className="whitespace-pre-wrap">{tpl.body}</p></div>}
        {needed.map((v) => <Field key={v} label={v}><input className="input" value={vars[v] ?? ''} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} /></Field>)}
      </div>}
      {step === 'schedule' && <div className="space-y-3">
        <div role="radiogroup" aria-label={t('p7.bc.when')} className="space-y-1">
          <label className="flex items-center gap-2"><input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} /> {t('p7.bc.now')}</label>
          <label className="flex items-center gap-2"><input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} /> {t('p7.bc.later')}</label>
        </div>
        {when === 'later' && <Field label={t('p7.bc.atIst')} error={badWhen && at ? t('p7.bc.badTime') : null}><input type="datetime-local" className="input" value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
        <p className="text-xs text-muted">{t('p7.bc.quietNote')}</p>
      </div>}
      {step === 'preview' && created && <PreviewSummary p={created.preview} />}
      <div className="mt-4 flex justify-between gap-2">
        <button type="button" className="btn" onClick={() => (step === 'audience' ? onClose() : step !== 'preview' && setStep(steps[steps.indexOf(step) - 1]!))} disabled={step === 'preview'}>{step === 'audience' ? t('common.cancel') : t('p6.prev')}</button>
        {step === 'audience' && <button className="btn btn-primary" disabled={!name.trim()} onClick={() => setStep('message')}>{t('p6.next')}</button>}
        {step === 'message' && <button className="btn btn-primary" disabled={!tpl || needed.some((v) => !vars[v]?.trim())} onClick={() => setStep('schedule')}>{t('p6.next')}</button>}
        {step === 'schedule' && <button className="btn btn-primary" disabled={badWhen || create.isPending} onClick={() => create.mutate()}>{t('p7.bc.dryRun')}</button>}
        {step === 'preview' && created && <div className="flex gap-2">
          <button className="btn" onClick={() => onDone(created.id)}>{t('p7.bc.keepDraft')}</button>
          <button className="btn btn-primary" disabled={!created.preview.eligible || send.isPending} onClick={() => send.mutate()}>
            {created.preview.needsApproval ? t('p7.bc.requestApproval') : when === 'later' ? t('p7.bc.schedule') : t('p7.bc.sendNow')}</button></div>}
      </div>
    </Dialog>
  );
}

const RSTATUSES = ['', 'pending', 'sent', 'failed', 'skipped_optout', 'skipped_nocontact', 'skipped_cap', 'cancelled'] as const;

function BroadcastDetail({ id }: { id: string }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const err = useCommError();
  const label = useLabel();
  const me = useMe().data;
  const { name } = useUsers();
  const [filter, setFilter] = useState<(typeof RSTATUSES)[number]>('');
  const [confirming, setConfirming] = useState(false);
  const q = useQuery({
    queryKey: ['comm', 'broadcast', id], queryFn: () => as<Broadcast>(api.GET('/comm/broadcasts/{id}', { params: { path: { id } } })),
    refetchInterval: (qq) => (qq.state.data && ['sending', 'scheduled'].includes(qq.state.data.status) ? 5000 : false),
  });
  const b = q.data;
  const recips = useQuery({ queryKey: ['comm', 'broadcast', id, 'recipients', filter, b?.progress?.done], enabled: !!b && b.status !== 'draft',
    queryFn: () => as<Recipient[]>(api.GET('/comm/broadcasts/{id}/recipients', { params: { path: { id }, query: filter ? { status: filter } : {} } })) });
  const preview = useQuery({ queryKey: ['comm', 'broadcast', id, 'preview'], enabled: b?.status === 'draft',
    queryFn: () => as<BroadcastPreview>(api.POST('/comm/broadcasts/{id}/preview', { params: { path: { id } } })) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['comm', 'broadcast', id] }); void qc.invalidateQueries({ queryKey: ['comm', 'broadcasts'] }); };
  const act = useMutation({
    mutationFn: (k: 'send' | 'approve' | 'cancel') => {
      const params = { path: { id } };
      return as<{ status: string }>(k === 'send' ? api.POST('/comm/broadcasts/{id}/send', { params, body: body({}) })
        : k === 'approve' ? api.POST('/comm/broadcasts/{id}/approve', { params }) : api.POST('/comm/broadcasts/{id}/cancel', { params }));
    },
    onSuccess: (r) => { refresh(); toast({ text: t('p7.bc.nowStatus', { status: label('bstatus', r.status) }), tone: 'ok' }, 4000); setConfirming(false); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const exp = useMutation({
    mutationFn: async () => { const f = await fetchBlob(`/comm/broadcasts/${id}/export`); saveBlob(f.blob, f.filename ?? `broadcast-${id.slice(0, 8)}.xlsx`); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  if (q.isError) return <p role="alert" className="card p-4">{t('clients.notFound')}</p>;
  if (!b) return <p className="text-muted">{t('common.loading')}</p>;
  const mine = b.createdBy === me?.id;
  const pct = b.progress ? progressPct(b.progress) : 0;
  return (
    <div className="space-y-3">
      <a href="#/comm/broadcasts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('p7.nav.broadcasts')}</a>
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{b.name}</h2><StatusBadge status={b.status} family="bstatus" />
        <span className="text-sm text-muted">{label('channel', b.channel)} · {t('p7.bc.by', { name: name(b.createdBy) })}{b.scheduledAt ? ` · ${formatDateTime(b.scheduledAt)}` : ''}</span>
        <div className="ml-auto flex gap-2">
          {b.status === 'draft' && mine && <button className="btn btn-primary" disabled={!preview.data?.eligible || act.isPending} onClick={() => act.mutate('send')}>{preview.data?.needsApproval ? t('p7.bc.requestApproval') : t('p7.bc.sendNow')}</button>}
          {b.status === 'pending_approval' && can('communication', 'approve') && (mine
            ? <span className="text-sm text-muted" data-testid="bc-self">{t('p7.bc.cannotApproveOwn')}</span>
            : <button className="btn btn-primary" disabled={act.isPending} onClick={() => act.mutate('approve')}>{t('p6.approve')}</button>)}
          {!['completed', 'cancelled'].includes(b.status) && can('communication', 'edit') && <button className="btn btn-danger" onClick={() => setConfirming(true)}>{t('p7.bc.cancel')}</button>}
          {b.status !== 'draft' && can('communication', 'export') && <button className="btn" disabled={exp.isPending} onClick={() => exp.mutate()}><Download size={14} aria-hidden /> {t('p7.bc.export')}</button>}
        </div>
      </header>
      {b.status === 'draft' && preview.data && <PreviewSummary p={preview.data} />}
      {b.progress && b.status !== 'draft' && <div className="card space-y-2 p-3">
        <div className="flex justify-between text-sm"><span>{t('p7.bc.progress', { done: b.progress.done, total: b.progress.total })}</span><span className="tabular-nums">{t('p7.bc.spent', { amount: formatINR(b.spentPaise) })}</span></div>
        <div role="progressbar" aria-label={t('p7.bc.progressLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded bg-surface-alt"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
        <div className="flex flex-wrap gap-2 text-xs">{Object.entries(b.progress.counts).map(([k, n]) => <span key={k}><StatusBadge status={k} family="rstatus" /> {n}</span>)}</div>
      </div>}
      {b.status !== 'draft' && <div className="space-y-2">
        <Field label={t('p6.f.status')}><select className="input w-56" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          {RSTATUSES.map((s) => <option key={s} value={s}>{s ? label('rstatus', s) : t('p7.tl.all')}</option>)}</select></Field>
        <div className="card overflow-auto"><table className="table w-full" aria-label={t('p7.bc.recipients')}>
          <thead><tr><th>{t('p6.f.client')}</th><th>{t('p7.f.address')}</th><th>{t('p6.f.status')}</th><th className="text-right">{t('p7.bc.cost')}</th><th>{t('p7.bc.sentAt')}</th></tr></thead>
          <tbody>{(recips.data ?? []).map((r) => (
            <tr key={r.id}><td>{r.clientName}</td><td className="font-mono text-xs">{r.address ?? '—'}</td><td><StatusBadge status={r.status} family="rstatus" />{r.error && <span className="block text-xs text-muted">{label('reason', r.error)}</span>}</td>
              <td className="text-right tabular-nums">{r.costPaise ? formatINR(r.costPaise) : '—'}</td><td>{r.sentAt ? formatDateTime(r.sentAt) : '—'}</td></tr>
          ))}</tbody>
        </table></div>
      </div>}
      {confirming && <Dialog title={t('p7.bc.cancelTitle')} onClose={() => setConfirming(false)}>
        <p className="mb-3 text-sm">{t('p7.bc.cancelBody')}</p>
        <div className="flex justify-end gap-2"><button className="btn" onClick={() => setConfirming(false)}>{t('common.close')}</button>
          <button className="btn btn-danger" disabled={act.isPending} onClick={() => act.mutate('cancel')}>{t('p7.bc.cancel')}</button></div>
      </Dialog>}
    </div>
  );
}
