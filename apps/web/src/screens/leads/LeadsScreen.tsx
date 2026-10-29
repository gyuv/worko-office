import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, LEAD_ACTIVITY_KINDS, LEAD_SOURCES, LEAD_STAGES, type LeadStage } from '@worko/domain';
import { formatDate, formatDateTime, type MessageKey } from '@worko/i18n';
import { Plus } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { errCode, useDebounced } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { isUuid, useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { as, body, type Duplicates, type LeadDetail, useUsers } from './api';
import { applyMove, dropNeighbours, filterBoard, moveBlocked, paiseToRupees, type Column, type Lead } from './logic';
import { ProposalEditor } from './ProposalEditor';

const stageKey = (s: string) => `p9.stage.${s}` as MessageKey;
const MOVE_CODES = ['lost_reason_required', 'lead_won_final', 'invalid_transition', 'convert_to_win'];
const sourceKey = (s: string) => `p9.source.${s}` as MessageKey;

/** `#/leads` board · `#/leads/<id>` detail · `#/leads/<id>/new` new proposal · `#/leads/p/<proposalId>` proposal. */
export function LeadsRoute() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  if (!can('leads', 'view')) return <p className="card p-4">{t('p9.noAccess')}</p>;
  if (params[0] === 'p' && isUuid(params[1])) return <ProposalEditor key={params[1]} proposalId={params[1]} />;
  if (isUuid(params[0]) && params[1] === 'new') return <ProposalEditor key={`new-${params[0]}`} leadId={params[0]} />;
  if (isUuid(params[0])) return <LeadDetailView key={params[0]} id={params[0]} />;
  return <LeadsBoard />;
}

function LeadsBoard() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const users = useUsers(can('users', 'view'));
  const q = useQuery({ queryKey: ['leads', 'board'], queryFn: () => as<Column[]>(api.GET('/leads/board')) });
  const [owner, setOwner] = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [lost, setLost] = useState<{ id: string; index: number } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: (m: { id: string; stage: LeadStage; index: number; lostReason?: string }) => {
      const col = q.data!.find((c) => c.stage === m.stage)!.items;
      return as(api.POST('/leads/{id}/move', { params: { path: { id: m.id } }, body: body({ stage: m.stage, ...dropNeighbours(col, m.id, m.index), ...(m.lostReason ? { lostReason: m.lostReason } : {}) }) }));
    },
    onMutate: (m) => { setErr(null); const prev = qc.getQueryData<Column[]>(['leads', 'board']); if (prev) qc.setQueryData(['leads', 'board'], applyMove(prev, m.id, m.stage, m.index, m.lostReason)); return { prev }; },
    onError: (e, _m, ctx) => { if (ctx?.prev) qc.setQueryData(['leads', 'board'], ctx.prev); const c = errCode(e); setErr(c && MOVE_CODES.includes(c) ? t(`p9.move.${c}` as MessageKey) : t('p9.move.failed', { reason: (e as Error).message })); },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['leads', 'board'] }),
  });
  const all = q.data ?? [];
  const board = filterBoard(all, { ownerId: owner || undefined, source: source || undefined, q: search });
  const editable = can('leads', 'edit');

  const request = (id: string, stage: LeadStage, index: number) => {
    const lead = all.flatMap((c) => c.items).find((l) => l.id === id);
    if (!lead) return;
    const blocked = moveBlocked(lead.stage, stage, !!lead.clientId);
    if (blocked) { setErr(t(`p9.move.${blocked}` as MessageKey)); return; }
    if (stage === 'lost' && lead.stage !== 'lost') { setLost({ id, index }); return; }
    move.mutate({ id, stage, index });
  };
  const onDrop = (e: DragEvent, stage: LeadStage, index: number) => { e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData('text/plain') || drag; setDrag(null); if (id) request(id, stage, index); };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">{t('p9.leads.title')}</h1>
        <input className="input w-48" placeholder={t('common.search')} aria-label={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        {users.data && <select className="input w-auto" aria-label={t('p9.leads.owner')} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{t('p9.leads.allOwners')}</option>{users.data.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        <select className="input w-auto" aria-label={t('p9.leads.source')} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">{t('p9.leads.allSources')}</option>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{t(sourceKey(s))}</option>)}</select>
        {can('leads', 'create') && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t('p9.leads.new')}</button>}
      </div>
      {err && <p role="alert" className="text-sm text-overdue">{err}</p>}
      {!q.data ? <p className="text-muted" aria-live="polite">{t('common.loading')}</p> : (
        <div className="flex gap-3 overflow-x-auto pb-2" role="list" aria-label={t('p9.leads.board')}>
          {board.map((c) => (
            <section key={c.stage} role="listitem" aria-label={t(stageKey(c.stage))} data-testid={`col-${c.stage}`} className="card flex w-64 shrink-0 flex-col p-2"
              onDragOver={(e) => editable && e.preventDefault()} onDrop={(e) => onDrop(e, c.stage, c.items.length)}>
              <header className="mb-2 flex items-baseline justify-between"><h2 className="font-semibold">{t(stageKey(c.stage))} <span className="text-muted">({c.count})</span></h2>
                <span className="text-xs text-muted">{formatINR(c.valuePaise)}</span></header>
              <ol className="space-y-2">
                {c.items.map((l, i) => (
                  <li key={l.id} draggable={editable} data-testid={`lead-${l.id}`} onDragStart={(e) => { e.dataTransfer.setData('text/plain', l.id); setDrag(l.id); }}
                    onDragOver={(e) => editable && e.preventDefault()} onDrop={(e) => onDrop(e, c.stage, i)}
                    className="rounded border border-border bg-surface p-2 text-sm">
                    <a className="font-medium underline-offset-2 hover:underline" href={`#/leads/${l.id}`}>{l.company || l.name}</a>
                    {l.company && <div className="text-xs text-muted">{l.name}</div>}
                    <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted">
                      {l.expectedValuePaise > 0 && <span>{formatINR(l.expectedValuePaise)}</span>}
                      <span>{t(sourceKey(l.source))}</span>
                      {l.nextFollowupOn && <span>{t('p9.leads.followup', { d: formatDate(l.nextFollowupOn) })}</span>}
                    </div>
                    {l.lostReason && <div className="text-xs text-overdue">{l.lostReason}</div>}
                    {editable && <label className="mt-1 block"><span className="sr-only">{t('p9.leads.moveTo', { name: l.company || l.name })}</span>
                      <select className="input py-0 text-xs" aria-label={t('p9.leads.moveTo', { name: l.company || l.name })} value={l.stage}
                        onChange={(e) => request(l.id, e.target.value as LeadStage, Number.MAX_SAFE_INTEGER)}>
                        {LEAD_STAGES.map((s) => <option key={s} value={s}>{t(stageKey(s))}</option>)}</select></label>}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
      {creating && <NewLeadDialog onClose={() => setCreating(false)} />}
      {lost && <LostDialog onClose={() => setLost(null)} onSave={(reason) => { move.mutate({ id: lost.id, stage: 'lost', index: lost.index, lostReason: reason }); setLost(null); }} />}
    </div>
  );
}

export function LostDialog({ onClose, onSave }: { onClose(): void; onSave(reason: string): void }) {
  const t = useT();
  const [reason, setReason] = useState('');
  return (
    <Dialog title={t('p9.lost.title')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 2) onSave(reason.trim()); }}>
        <Field label={t('p9.lost.reason')}><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={2} maxLength={500} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={reason.trim().length < 2}>{t('p9.lost.save')}</button></div>
      </form>
    </Dialog>
  );
}

export function DuplicateWarning({ d }: { d: Duplicates | undefined }) {
  const t = useT();
  if (!d || (!d.clients.length && !d.leads.length && !d.hiddenClients)) return null;
  return (
    <div role="status" className="rounded border border-due-soon p-2 text-sm" data-testid="dup-warning">
      <p className="font-medium text-due-soon">{t('p9.dup.title')}</p>
      <ul className="list-disc pl-5">
        {d.clients.map((c) => <li key={c.id}><a className="underline" href={`#/clients/${c.id}`}>{c.name}</a> <span className="text-muted">({t('p9.dup.client')} · {c.matchedOn.join(', ')})</span></li>)}
        {d.leads.map((l) => <li key={l.id}><a className="underline" href={`#/leads/${l.id}`}>{l.company || l.name}</a> <span className="text-muted">({t('p9.dup.lead')} · {t(stageKey(l.stage))} · {l.matchedOn.join(', ')})</span></li>)}
      </ul>
      {d.hiddenClients > 0 && <p className="text-muted">{t('p9.dup.hidden', { n: d.hiddenClients })}</p>}
    </div>
  );
}

function NewLeadDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const [f, setF] = useState({ name: '', company: '', email: '', phone: '', pan: '', gstin: '', source: 'referral', value: '', followup: '', notes: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const keyFields = useDebounced({ pan: f.pan.trim().toUpperCase(), gstin: f.gstin.trim().toUpperCase(), email: f.email.trim(), phone: f.phone.trim() }, 400);
  const anyKey = Object.values(keyFields).some((v) => v.length >= 5);
  const dup = useQuery({ queryKey: ['leads', 'dup', keyFields], enabled: anyKey, retry: false,
    queryFn: () => as<Duplicates>(api.GET('/leads/duplicates', { params: { query: Object.fromEntries(Object.entries(keyFields).filter(([, v]) => v)) } })) });
  const create = useMutation({
    mutationFn: () => as<{ id: string }>(api.POST('/leads', { body: body({
      name: f.name.trim(), source: f.source, ...(f.company.trim() ? { company: f.company.trim() } : {}), ...(f.email.trim() ? { email: f.email.trim() } : {}), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
      ...(f.pan.trim() ? { pan: f.pan.trim().toUpperCase() } : {}), ...(f.gstin.trim() ? { gstin: f.gstin.trim().toUpperCase() } : {}), ...(f.followup ? { nextFollowupOn: f.followup } : {}),
      ...(f.notes.trim() ? { notes: f.notes.trim() } : {}), ...(f.value ? { expectedValuePaise: Math.round(Number(f.value) * 100) } : {}),
    }) })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['leads'] }); onClose(); go(`leads/${r.id}`); },
  });
  return (
    <Dialog title={t('p9.leads.new')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (f.name.trim()) create.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('p9.lf.name')}><input className="input" value={f.name} onChange={set('name')} required /></Field>
          <Field label={t('p9.lf.company')}><input className="input" value={f.company} onChange={set('company')} /></Field>
          <Field label={t('p9.lf.email')}><input type="email" className="input" value={f.email} onChange={set('email')} /></Field>
          <Field label={t('p9.lf.phone')}><input type="tel" className="input" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="PAN"><input className="input font-mono uppercase" value={f.pan} onChange={set('pan')} maxLength={10} /></Field>
          <Field label="GSTIN"><input className="input font-mono uppercase" value={f.gstin} onChange={set('gstin')} maxLength={15} /></Field>
          <Field label={t('p9.leads.source')}><select className="input" value={f.source} onChange={set('source')}>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{t(sourceKey(s))}</option>)}</select></Field>
          <Field label={t('p9.lf.value')}><input className="input" inputMode="decimal" value={f.value} onChange={set('value')} /></Field>
          <Field label={t('p9.lf.followup')}><input type="date" className="input" value={f.followup} onChange={set('followup')} /></Field>
        </div>
        <Field label={t('p9.lf.notes')}><textarea className="input" value={f.notes} onChange={set('notes')} /></Field>
        <DuplicateWarning d={anyKey ? dup.data : undefined} />
        {create.isError && <p role="alert" className="text-sm text-overdue">{(create.error as Error).message}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!f.name.trim() || create.isPending}>{t('p9.leads.create')}</button></div>
      </form>
    </Dialog>
  );
}

function LeadDetailView({ id }: { id: string }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['leads', id], retry: false, queryFn: () => as<LeadDetail>(api.GET('/leads/{id}', { params: { path: { id } } })) });
  const [kind, setKind] = useState<(typeof LEAD_ACTIVITY_KINDS)[number]>('note');
  const [text, setText] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['leads'] });
  const log = useMutation({ mutationFn: () => as(api.POST('/leads/{id}/activities', { params: { path: { id } }, body: { kind, body: text.trim() } })), onSuccess: () => { setText(''); refresh(); } });
  const patch = useMutation({ mutationFn: (b: Record<string, unknown>) => as(api.PATCH('/leads/{id}', { params: { path: { id } }, body: body(b) })), onSuccess: refresh });
  if (q.isError) return <p role="alert" className="card p-4">{t('p9.notFound')} <a className="underline" href="#/leads">{t('p9.leads.title')}</a></p>;
  if (!q.data) return <p className="text-muted">{t('common.loading')}</p>;
  const l = q.data;
  const edit = can('leads', 'edit');
  return (
    <div className="space-y-3">
      <a href="#/leads" className="text-sm text-muted hover:text-fg">← {t('p9.leads.title')}</a>
      <header className="flex flex-wrap items-start gap-2">
        <div className="flex-1"><h1 className="text-xl font-semibold">{l.company || l.name}</h1>
          <p className="text-sm text-muted">{[l.company ? l.name : null, l.email, l.phone, l.pan, t(stageKey(l.stage)), t(sourceKey(l.source))].filter(Boolean).join(' · ')}</p>
          {l.lostReason && <p className="text-sm text-overdue">{t('p9.lost.was', { reason: l.lostReason })}</p>}
          {l.clientId && <p className="text-sm"><a className="underline" href={`#/clients/${l.clientId}`}>{t('p9.leads.openClient')}</a></p>}</div>
        {can('leads', 'create') && !['won', 'lost'].includes(l.stage) && <a className="btn btn-primary" href={`#/leads/${l.id}/new`}>{t('p9.prop.new')}</a>}
      </header>
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="card space-y-2 p-4" aria-label={t('p9.leads.details')}>
          <h2 className="font-semibold">{t('p9.leads.details')}</h2>
          <Field label={t('p9.lf.followup')}><input type="date" className="input w-48" disabled={!edit} value={l.nextFollowupOn ?? ''} onChange={(e) => patch.mutate({ nextFollowupOn: e.target.value || null })} /></Field>
          <p className="text-sm">{t('p9.lf.value')}: {formatINR(l.expectedValuePaise)} <span className="text-muted">({paiseToRupees(l.expectedValuePaise)})</span></p>
          {l.notes && <p className="whitespace-pre-wrap text-sm">{l.notes}</p>}
          {patch.isError && <p role="alert" className="text-sm text-overdue">{(patch.error as Error).message}</p>}
        </section>
        <section className="card space-y-2 p-4" aria-label={t('p9.prop.list')}>
          <h2 className="font-semibold">{t('p9.prop.list')}</h2>
          {!l.proposals.length ? <p className="text-sm text-muted">{t('p9.prop.none')}</p> : <ul className="divide-y divide-border text-sm">{l.proposals.map((p) => (
            <li key={p.id} className="flex gap-2 py-1.5"><a className="flex-1 underline" href={`#/leads/p/${p.id}`}>{p.number} · {p.title}</a><span>v{p.currentVersion}</span><span>{t(`p9.pst.${p.status}` as MessageKey)}</span></li>))}</ul>}
        </section>
      </div>
      <section className="card space-y-2 p-4" aria-label={t('p9.act.title')}>
        <h2 className="font-semibold">{t('p9.act.title')}</h2>
        {edit && <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) log.mutate(); }}>
          <select className="input w-auto" aria-label={t('p9.act.kind')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{LEAD_ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{t(`p9.act.${k}` as MessageKey)}</option>)}</select>
          <input className="input min-w-0 flex-1" aria-label={t('p9.act.body')} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
          <button className="btn" disabled={!text.trim() || log.isPending}>{t('p9.act.log')}</button></form>}
        <ul className="divide-y divide-border text-sm">{l.activities.map((a) => (
          <li key={a.id} className="py-1.5"><span className="text-xs text-muted">{formatDateTime(a.at)} · {a.kind}</span><div className="whitespace-pre-wrap">{a.body ?? (a.meta?.to ? `${t(stageKey(String(a.meta.from)))} → ${t(stageKey(String(a.meta.to)))}` : '')}</div></li>))}</ul>
      </section>
    </div>
  );
}

export type { Lead };
