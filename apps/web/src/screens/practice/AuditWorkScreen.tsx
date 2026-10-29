import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SIGNOFF_LEVELS, type SignoffLevel } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { ArrowLeft, ExternalLink, FileUp, History, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { currentFy, todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { isUuid, useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { PersonSelect, useUsers } from '../tasks/shared';
import { TaskDrawer } from '../tasks/TaskDrawer';
import {
  as, body, openDoc, uploadDoc, useClientDocs, useP8Error, useP8Label,
  type Engagement, type EngagementDetail, type Pbc, type Procedure, type Programme, type ProgrammeSection, type TrailRow, type Udin, type Workpaper,
} from './api';
import { normalizeUdin, signoffButton, signRights, udinInputError, type MeLike } from './logic';

type View = 'engagements' | 'programmes';

export function AuditWorkScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  if (!can('audit', 'view')) return <p className="card p-6 text-muted">{t('p8.noAccess')}</p>;
  if (isUuid(params[0])) return <EngagementView id={params[0]} />;
  const view: View = params[0] === 'programmes' ? 'programmes' : 'engagements';
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p8.nav.engagements')}</h1>
      <Tabs<View> label={t('p8.nav.engagements')} value={view} onChange={(v) => go(v === 'engagements' ? 'engagements' : 'engagements/programmes')}
        tabs={[['engagements', t('p8.a.engagements')], ['programmes', t('p8.a.programmes')]]} />
      {view === 'engagements' ? <EngagementList /> : <Programmes />}
    </div>
  );
}

const useProgrammes = () => useQuery({ queryKey: ['p8', 'programmes'], queryFn: () => as<Programme[]>(api.GET('/audit/programmes')) });

function EngagementList() {
  const t = useT();
  const can = useCan();
  const label = useP8Label();
  const [client, setClient] = useState<PickedClient | null>(null);
  const [fy, setFy] = useState('');
  const [creating, setCreating] = useState(false);
  const query = { ...(client ? { clientId: client.id } : {}), ...(fy ? { fy } : {}), limit: 200 };
  const q = useQuery({ queryKey: ['p8', 'engagements', query], queryFn: () => as<{ total: number; items: Engagement[] }>(api.GET('/audit/engagements', { params: { query: query as never } })) });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-60"><ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} /></div>
        <Field label={t('p8.f.fy')}><input className="input w-28" placeholder="2026-27" value={fy} onChange={(e) => setFy(e.target.value)} /></Field>
        {can('audit', 'create') && <button className="btn btn-primary ml-auto" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t('p8.a.newEngagement')}</button>}
      </div>
      {q.data && !q.data.items.length && <p className="card p-6 text-muted">{t('p8.a.none')}</p>}
      {!!q.data?.items.length && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p8.a.engagements')}>
        <thead><tr><th>{t('p8.f.client')}</th><th>{t('p8.f.fy')}</th><th>{t('p8.a.type')}</th><th>{t('p8.f.status')}</th><th>UDIN</th></tr></thead>
        <tbody>{q.data.items.map((e) => (
          <tr key={e.id}><td><a className="hover:underline" href={`#/engagements/${e.id}`}>{e.clientName}</a></td><td>{e.fy}</td><td>{label('atype', e.auditType)}</td><td>{label('estatus', e.status)}</td>
            <td>{e.udinRequired ? t('p8.a.udinNeeded') : '—'}</td></tr>
        ))}</tbody>
      </table></div>}
      {creating && <NewEngagement onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewEngagement({ onClose }: { onClose(): void }) {
  const t = useT();
  const err = useP8Error();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const label = useP8Label();
  const progs = (useProgrammes().data ?? []).filter((p) => p.active);
  const [client, setClient] = useState<PickedClient | null>(null);
  const [fy, setFy] = useState(currentFy());
  const [progId, setProgId] = useState('');
  const [partner, setPartner] = useState<string | null>(null);
  const [reportDue, setDue] = useState('');
  const [createTask, setCreateTask] = useState(true);
  const prog = progs.find((p) => p.id === (progId || progs[0]?.id));
  const m = useMutation({
    mutationFn: () => as<{ id: string }>(api.POST('/audit/engagements', { body: body({ clientId: client!.id, fy, auditType: prog!.auditType, programmeId: prog!.id, partnerId: partner, createTask, reportDue: reportDue || null }) })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['p8'] }); go(`engagements/${r.id}`); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p8.a.newEngagement')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (client && prog) m.mutate(); }}>
        <ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('p8.f.fy')}><input className="input" pattern="\d{4}-\d{2}" value={fy} onChange={(e) => setFy(e.target.value)} required /></Field>
          <Field label={t('p8.a.programme')}><select className="input" value={prog?.id ?? ''} onChange={(e) => setProgId(e.target.value)}>
            {progs.map((p) => <option key={p.id} value={p.id}>{p.name} ({label('atype', p.auditType)})</option>)}</select></Field>
        </div>
        {!progs.length && <p className="text-sm text-due-soon">{t('p8.a.noProgrammes')}</p>}
        <PersonSelect label={t('p8.a.partner')} value={partner} onChange={setPartner} />
        <Field label={t('p8.a.reportDue')}><input type="date" className="input" value={reportDue} onChange={(e) => setDue(e.target.value)} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={createTask} onChange={(e) => setCreateTask(e.target.checked)} /> {t('p8.a.createTask')}</label>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={!client || !prog || m.isPending}>{t('p8.create')}</button></div>
      </form>
    </Dialog>
  );
}

// ---------- Programmes (templates) ----------
function Programmes() {
  const t = useT();
  const me = useMe().data;
  const label = useP8Label();
  const q = useProgrammes();
  const firmWide = !!me?.grants.some((g) => g.module === 'audit' && (g.action === 'create' || g.action === 'edit') && g.scope === 'all');
  const [editing, setEditing] = useState<Programme | 'new' | null>(null);
  return (
    <div className="space-y-2">
      {firmWide ? <div className="flex justify-end"><button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('p8.a.newProgramme')}</button></div>
        : <p className="text-sm text-muted">{t('p8.a.firmWideOnly')}</p>}
      <ul className="space-y-2">{(q.data ?? []).map((p) => (
        <li key={p.id} className={`card flex items-center gap-2 p-3 ${p.active ? '' : 'opacity-60'}`}>
          <div className="flex-1"><div className="font-medium">{p.name}</div><div className="text-xs text-muted">{label('atype', p.auditType)} · {t('p8.a.procCount', { count: p.sections.reduce((n, s) => n + s.procedures.length, 0) })}{p.udinRequired ? ` · ${t('p8.a.udinNeeded')}` : ''}</div></div>
          {firmWide && <button className="btn" onClick={() => setEditing(p)}>{t('p8.edit')}</button>}
        </li>
      ))}</ul>
      {editing && <ProgrammeEditor p={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'item';

function ProgrammeEditor({ p, onClose }: { p: Programme | null; onClose(): void }) {
  const t = useT();
  const err = useP8Error();
  const qc = useQueryClient();
  const [name, setName] = useState(p?.name ?? '');
  const [auditType, setType] = useState(p?.auditType ?? 'statutory_audit');
  const [udinRequired, setUdin] = useState(p?.udinRequired ?? true);
  const [active, setActive] = useState(p?.active ?? true);
  const [sections, setSections] = useState<ProgrammeSection[]>(p?.sections ?? [{ key: 'planning', title: 'Planning', procedures: [] }]);
  const setSec = (i: number, s: ProgrammeSection) => setSections(sections.map((x, j) => (j === i ? s : x)));
  const m = useMutation({
    mutationFn: () => p ? as(api.PATCH('/audit/programmes/{id}', { params: { path: { id: p.id } }, body: body({ name, sections, udinRequired, active }) }))
      : as(api.POST('/audit/programmes', { body: body({ name, auditType, sections, udinRequired }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['p8', 'programmes'] }); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={p ? t('p8.a.editProgramme') : t('p8.a.newProgramme')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('p8.a.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label={t('p8.a.type')}><input className="input" value={auditType} disabled={!!p} pattern="[a-z0-9_]{2,40}" onChange={(e) => setType(e.target.value)} /></Field>
        </div>
        <div className="flex gap-4"><label className="flex items-center gap-2"><input type="checkbox" checked={udinRequired} onChange={(e) => setUdin(e.target.checked)} /> {t('p8.a.udinRequired')}</label>
          {p && <label className="flex items-center gap-2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('p8.a.active')}</label>}</div>
        {sections.map((s, i) => (
          <fieldset key={i} className="space-y-2 rounded border border-border p-2">
            <legend className="px-1 text-sm">{t('p8.a.section', { n: i + 1 })}</legend>
            <div className="flex gap-2"><input className="input flex-1" aria-label={t('p8.a.sectionTitle')} value={s.title} onChange={(e) => setSec(i, { ...s, title: e.target.value, key: p ? s.key : keyOf(e.target.value) })} required />
              <button type="button" className="btn" aria-label={t('p8.remove')} onClick={() => setSections(sections.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>
            {s.procedures.map((pr, k) => (
              <div key={k} className="ml-4 grid gap-1 sm:grid-cols-[1fr_1fr_auto]">
                <input className="input" aria-label={t('p8.a.procedure')} value={pr.title} required
                  onChange={(e) => setSec(i, { ...s, procedures: s.procedures.map((x, j) => (j === k ? { ...x, title: e.target.value, key: x.key && p ? x.key : keyOf(e.target.value) } : x)) })} />
                <input className="input" aria-label={t('p8.a.evidence')} placeholder={t('p8.a.evidenceHint')} value={pr.evidence.join(', ')}
                  onChange={(e) => setSec(i, { ...s, procedures: s.procedures.map((x, j) => (j === k ? { ...x, evidence: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) } : x)) })} />
                <button type="button" className="btn" aria-label={t('p8.remove')} onClick={() => setSec(i, { ...s, procedures: s.procedures.filter((_, j) => j !== k) })}><Trash2 size={14} /></button>
              </div>
            ))}
            <button type="button" className="btn ml-4" onClick={() => setSec(i, { ...s, procedures: [...s.procedures, { key: `p${s.procedures.length + 1}`, title: '', evidence: [] }] })}><Plus size={14} aria-hidden /> {t('p8.a.addProcedure')}</button>
          </fieldset>
        ))}
        <button type="button" className="btn" onClick={() => setSections([...sections, { key: `s${sections.length + 1}`, title: '', procedures: [] }])}><Plus size={14} aria-hidden /> {t('p8.a.addSection')}</button>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={!name.trim() || !sections.length || m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

// ---------- Engagement detail ----------
type ETab = 'procedures' | 'pbc' | 'udin';

function EngagementView({ id }: { id: string }) {
  const t = useT();
  const label = useP8Label();
  const can = useCan();
  const err = useP8Error();
  const qc = useQueryClient();
  const { name } = useUsers();
  const [tab, setTab] = useState<ETab>('procedures');
  const [task, setTask] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['p8', 'engagement', id], retry: false, queryFn: () => as<EngagementDetail>(api.GET('/audit/engagements/{id}', { params: { path: { id } } })) });
  const status = useMutation({
    mutationFn: (s: string) => as(api.PATCH('/audit/engagements/{id}', { params: { path: { id } }, body: body({ status: s }) })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['p8'] }), onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  if (q.isError) return <div role="alert" className="card p-6">{t('p8.notFound')} <a className="underline" href="#/engagements">{t('p8.nav.engagements')}</a></div>;
  const e = q.data;
  if (!e) return <p className="text-muted">{t('common.loading')}</p>;
  const pct = (n: number) => (e.progress.total ? Math.round((n / e.progress.total) * 100) : 0);
  return (
    <div className="space-y-3">
      <a href="#/engagements" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('p8.nav.engagements')}</a>
      <header className="flex flex-wrap items-start gap-2">
        <div className="flex-1"><h1 className="text-xl font-semibold">{e.clientName} · {label('atype', e.auditType)} · FY {e.fy}</h1>
          <p className="text-sm text-muted">{t('p8.a.partner')}: {name(e.partnerId)} · {t('p8.a.progress', { prepared: pct(e.progress.prepared), reviewed: pct(e.progress.reviewed), partner: pct(e.progress.partner) })}</p></div>
        {can('audit', 'edit') ? <Field label={t('p8.f.status')}><select className="input" value={e.status} onChange={(ev) => status.mutate(ev.target.value)}>
          {['planning', 'fieldwork', 'review', 'reporting', 'closed'].map((s) => <option key={s} value={s}>{label('estatus', s)}</option>)}</select></Field> : <span>{label('estatus', e.status)}</span>}
        {e.taskId && <button className="btn" onClick={() => setTask(e.taskId)}>{t('p8.n.openTask')}</button>}
      </header>
      <UdinGateBanner e={e} />
      <Tabs<ETab> label={t('p8.a.engagement')} value={tab} onChange={setTab} tabs={[['procedures', t('p8.a.procedures')], ['pbc', t('p8.a.pbc')], ['udin', 'UDIN']]} />
      {tab === 'procedures' && <ProcedureList e={e} />}
      {tab === 'pbc' && <PbcPanel e={e} />}
      {tab === 'udin' && <UdinPanel e={e} />}
      {task && <TaskDrawer id={task} onClose={() => setTask(null)} />}
    </div>
  );
}

/** Which task is blocked by a missing UDIN (D116). */
function UdinGateBanner({ e }: { e: EngagementDetail }) {
  const t = useT();
  if (!e.udinRequired) return null;
  return e.udinRecorded
    ? <p role="status" data-testid="udin-gate" className="card p-2 text-sm text-done">{t('p8.u.gateOpen')}</p>
    : <p role="status" data-testid="udin-gate" className="card border-due-soon p-2 text-sm text-due-soon">{e.taskId ? t('p8.u.gateBlocked') : t('p8.u.gateBlockedNoTask')}</p>;
}

function ProcedureList({ e }: { e: EngagementDetail }) {
  const groups = new Map<string, Procedure[]>();
  for (const p of e.procedures) groups.set(p.sectionTitle, [...(groups.get(p.sectionTitle) ?? []), p]);
  return <div className="space-y-3">{[...groups].map(([title, ps]) => (
    <section key={title} className="card p-3" aria-label={title}><h2 className="mb-2 font-medium">{title}</h2>
      <ul className="divide-y divide-border">{ps.map((p) => <ProcedureRow key={p.id} p={p} e={e} />)}</ul></section>
  ))}</div>;
}

function ProcedureRow({ p, e }: { p: Procedure; e: EngagementDetail }) {
  const t = useT();
  const err = useP8Error();
  const qc = useQueryClient();
  const me = useMe().data;
  const { name } = useUsers();
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const wps = useQuery({ queryKey: ['p8', 'wp', p.id], enabled: open || p.workpapers > 0, queryFn: () => as<Workpaper[]>(api.GET('/audit/procedures/{id}/workpapers', { params: { path: { id: p.id } } })) });
  const stale = (wps.data ?? []).some((w) => w.currentVersion !== w.documentVersion);
  const rights = me ? signRights(me as unknown as MeLike, e) : { canPrepare: false, canReview: false, canPartner: false };
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['p8', 'engagement', e.id] }); void qc.invalidateQueries({ queryKey: ['p8', 'wp', p.id] }); };
  const sign = useMutation({
    mutationFn: (level: SignoffLevel) => as(api.POST('/audit/procedures/{id}/signoff', { params: { path: { id: p.id } }, body: body({ level }) })),
    onSuccess: () => { setRefusal(null); refresh(); }, onError: (x) => { setRefusal(err(x)); refresh(); },
  });
  const reopen = useMutation({
    mutationFn: (reason: string) => as(api.POST('/audit/procedures/{id}/reopen', { params: { path: { id: p.id } }, body: body({ reason }) })),
    onSuccess: refresh, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  const na = useMutation({
    mutationFn: (v: boolean) => as(api.PATCH('/audit/procedures/{id}', { params: { path: { id: p.id } }, body: body({ notApplicable: v }) })),
    onSuccess: refresh, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  const by = { preparer: [p.preparedBy, p.preparedAt], reviewer: [p.reviewedBy, p.reviewedAt], partner: [p.partnerBy, p.partnerAt] } as const;
  return (
    <li className="space-y-1 py-2" data-testid={`proc-${p.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button className="flex-1 text-left" aria-expanded={open} onClick={() => setOpen(!open)}><span className={p.notApplicable ? 'line-through text-muted' : ''}>{p.title}</span>
          {p.requiredEvidence.length > 0 && <span className="block text-xs text-muted">{t('p8.a.evidence')}: {p.requiredEvidence.join(', ')}</span>}</button>
        <span className="text-xs text-muted">{t('p8.a.wpCount', { count: p.workpapers })}</span>
        {SIGNOFF_LEVELS.map((l) => {
          const s = me ? signoffButton(p, l, me.id, rights, stale) : { enabled: false, reason: null, signed: false };
          const why = s.reason && !s.signed ? t(`p8.why.${s.reason}` as never) : undefined;
          return (
            <span key={l} className="inline-flex flex-col items-center">
              <button className={`btn ${s.signed ? 'text-done' : ''}`} disabled={!s.enabled || sign.isPending} title={why} aria-describedby={why ? `why-${p.id}-${l}` : undefined}
                onClick={() => sign.mutate(l)}>{s.signed ? `✓ ${t(`p8.lvl.${l}`)}` : t('p8.a.signAs', { level: t(`p8.lvl.${l}`) })}</button>
              {s.signed && <span className="text-xs text-muted">{name(by[l][0])} · {by[l][1] ? formatDate(by[l][1]!) : ''}</span>}
              {why && <span id={`why-${p.id}-${l}`} className="text-xs text-muted" data-testid={`why-${p.key}-${l}`}>{why}</span>}
            </span>
          );
        })}
        <button className="btn" aria-label={t('p8.a.trail')} onClick={() => setTrail(true)}><History size={14} /></button>
        {rights.canPartner && (p.preparedBy || p.reviewedBy || p.partnerBy) && <button className="btn" onClick={() => { const r = prompt(t('p8.a.reopenReason')); if (r?.trim()) reopen.mutate(r.trim()); }}>{t('p8.a.reopen')}</button>}
      </div>
      {refusal && <p role="alert" className="text-sm text-overdue" data-testid={`refusal-${p.key}`}>{refusal}</p>}
      {stale && <p className="text-xs text-due-soon">{t('p8.why.evidence_changed')}</p>}
      {open && <div className="ml-4 space-y-2">
        {rights.canPrepare && !p.reviewedBy && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={p.notApplicable} onChange={(ev) => na.mutate(ev.target.checked)} /> {t('p8.a.na')}</label>}
        <Workpapers p={p} e={e} list={wps.data ?? []} canEdit={rights.canPrepare} onChange={refresh} />
      </div>}
      {trail && <TrailDialog p={p} onClose={() => setTrail(false)} />}
    </li>
  );
}

function Workpapers({ p, e, list, canEdit, onChange }: { p: Procedure; e: EngagementDetail; list: Workpaper[]; canEdit: boolean; onChange(): void }) {
  const t = useT();
  const err = useP8Error();
  const docs = useClientDocs(canEdit ? e.clientId : null).data ?? [];
  const [pick, setPick] = useState('');
  const link = useMutation({
    mutationFn: (documentId: string) => as<{ invalidated: string[] }>(api.POST('/audit/procedures/{id}/workpapers', { params: { path: { id: p.id } }, body: body({ documentId }) })),
    onSuccess: (r) => { if (r.invalidated?.length) toast({ text: t('p8.a.invalidated', { levels: r.invalidated.join(', ') }) }); onChange(); },
    onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  const unlink = useMutation({ mutationFn: (id: string) => as(api.DELETE('/audit/workpapers/{id}', { params: { path: { id } } })), onSuccess: onChange, onError: (x) => toast({ text: err(x), tone: 'error' }) });
  const upload = useMutation({
    mutationFn: async ({ f, documentId }: { f: File; documentId?: string }) => {
      const d = await uploadDoc({ file: f, clientId: e.clientId, category: 'Audit workpapers', documentId });
      if (!documentId) await link.mutateAsync(d.id);
    },
    onSuccess: onChange, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  return (
    <div className="space-y-1 text-sm">
      <h3 className="font-medium">{t('p8.a.workpapers')}</h3>
      {!list.length && <p className="text-muted">{t('p8.a.noWorkpapers')}</p>}
      <ul>{list.map((w) => (
        <li key={w.id} className="flex flex-wrap items-center gap-2">
          <button className="underline-offset-2 hover:underline" onClick={() => void openDoc(w.documentId, w.documentVersion)}>{w.name}</button>
          <span className="text-xs text-muted">{t('p8.a.linkedVersion', { v: w.documentVersion })}{w.currentVersion !== w.documentVersion ? ` · ${t('p8.a.newerVersion', { v: w.currentVersion })}` : ''}</span>
          {canEdit && w.currentVersion !== w.documentVersion && <button className="btn" onClick={() => link.mutate(w.documentId)}>{t('p8.a.refresh')}</button>}
          {canEdit && <label className="btn cursor-pointer">{t('p8.a.newVersion')}<input type="file" className="sr-only" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) upload.mutate({ f, documentId: w.documentId }); ev.target.value = ''; }} /></label>}
          {canEdit && <button className="btn" aria-label={t('p8.remove')} onClick={() => unlink.mutate(w.id)}><Trash2 size={14} /></button>}
        </li>
      ))}</ul>
      {canEdit && <div className="flex flex-wrap items-end gap-2">
        <select className="input w-60" aria-label={t('p8.a.linkExisting')} value={pick} onChange={(ev) => setPick(ev.target.value)}>
          <option value="">{t('p8.a.linkExisting')}</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <button className="btn" disabled={!pick} onClick={() => { link.mutate(pick); setPick(''); }}>{t('p8.a.link')}</button>
        <label className="btn cursor-pointer"><FileUp size={14} aria-hidden /> {t('p8.a.uploadWp')}<input type="file" className="sr-only" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) upload.mutate({ f }); ev.target.value = ''; }} /></label>
      </div>}
    </div>
  );
}

function TrailDialog({ p, onClose }: { p: Procedure; onClose(): void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['p8', 'trail', p.id], queryFn: () => as<TrailRow[]>(api.GET('/audit/procedures/{id}/trail', { params: { path: { id: p.id } } })) });
  return (
    <Dialog title={t('p8.a.trailOf', { title: p.title })} onClose={onClose} wide>
      {q.data && !q.data.length && <p className="text-muted">{t('p8.a.noTrail')}</p>}
      <ol className="space-y-1 text-sm">{(q.data ?? []).map((r, i) => (
        <li key={i}><span className="text-muted">{formatDateTime(r.at)}</span> · {r.userName ?? '—'} · {t(`p8.lvl.${r.level as SignoffLevel}`)} · <b>{t(`p8.trail.${r.action as 'signed'}`)}</b>{r.reason ? ` — ${r.reason}` : ''}</li>
      ))}</ol>
    </Dialog>
  );
}

function PbcPanel({ e }: { e: EngagementDetail }) {
  const t = useT();
  const err = useP8Error();
  const label = useP8Label();
  const can = useCan();
  const qc = useQueryClient();
  const docs = useClientDocs(e.clientId).data ?? [];
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [result, setResult] = useState<{ sent: number; skipped: Array<{ reason: string }> } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p8', 'engagement', e.id] });
  const add = useMutation({
    mutationFn: () => as(api.POST('/audit/engagements/{id}/pbc', { params: { path: { id: e.id } }, body: body({ items: [{ title: title.trim(), dueDate: due || null }] }) })),
    onSuccess: () => { setTitle(''); setDue(''); refresh(); }, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  const upd = useMutation({
    mutationFn: ({ id, b }: { id: string; b: Record<string, unknown> }) => as(api.PATCH('/audit/pbc/{id}', { params: { path: { id } }, body: body(b) })),
    onSuccess: refresh, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  const remind = useMutation({
    mutationFn: () => as<{ sent: number; skipped: Array<{ engagementId: string; reason: string }> }>(api.POST('/audit/engagements/{id}/pbc/remind', { params: { path: { id: e.id } } })),
    onSuccess: (r) => { setResult(r); refresh(); }, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  const editable = can('audit', 'edit');
  return (
    <div className="space-y-2">
      {editable && <form className="flex flex-wrap items-end gap-2" onSubmit={(ev) => { ev.preventDefault(); if (title.trim()) add.mutate(); }}>
        <Field label={t('p8.pbc.item')}><input className="input w-72" value={title} onChange={(ev) => setTitle(ev.target.value)} /></Field>
        <Field label={t('p8.pbc.due')}><input type="date" className="input" value={due} onChange={(ev) => setDue(ev.target.value)} /></Field>
        <button className="btn">{t('p8.pbc.add')}</button>
        <button type="button" className="btn ml-auto" onClick={() => remind.mutate()} disabled={remind.isPending}>{t('p8.pbc.remind')}</button>
      </form>}
      {result && <div role="status" className="card p-2 text-sm" data-testid="pbc-remind">{t('p8.pbc.sent', { count: result.sent })}
        {result.skipped.map((s, i) => <span key={i} className="block text-due-soon">{t('p8.pbc.skipped')}: {label('skip', s.reason)}</span>)}</div>}
      {!e.pbc.length && <p className="card p-4 text-muted">{t('p8.pbc.none')}</p>}
      {!!e.pbc.length && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p8.a.pbc')}>
        <thead><tr><th>{t('p8.pbc.item')}</th><th>{t('p8.pbc.due')}</th><th>{t('p8.f.status')}</th><th>{t('p8.pbc.docs')}</th><th>{t('p8.pbc.reminders')}</th></tr></thead>
        <tbody>{e.pbc.map((i: Pbc) => (
          <tr key={i.id}><td>{i.title}{i.rejectionReason && <span className="block text-xs text-overdue">{i.rejectionReason}</span>}</td><td>{i.dueDate ? formatDate(i.dueDate) : '—'}</td>
            <td>{editable ? <select className="input" aria-label={t('p8.f.status')} value={i.status} onChange={(ev) => {
              const s = ev.target.value; const reason = s === 'rejected' ? prompt(t('p8.pbc.rejectReason')) : null;
              upd.mutate({ id: i.id, b: { status: s, ...(s === 'rejected' ? { rejectionReason: reason || null } : {}) } });
            }}>{['requested', 'received', 'accepted', 'rejected'].map((s) => <option key={s} value={s}>{label('pbcs', s)}</option>)}</select> : label('pbcs', i.status)}</td>
            <td>{i.documentIds.map((d) => <button key={d} className="block text-xs underline" onClick={() => void openDoc(d)}>{docs.find((x) => x.id === d)?.name ?? d.slice(0, 8)}</button>)}
              {editable && <select className="input mt-1 text-xs" aria-label={t('p8.pbc.linkDoc')} value="" onChange={(ev) => ev.target.value && upd.mutate({ id: i.id, b: { documentIds: [...new Set([...i.documentIds, ev.target.value])], ...(i.status === 'requested' ? { status: 'received' } : {}) } })}>
                <option value="">{t('p8.pbc.linkDoc')}</option>{docs.filter((d) => !i.documentIds.includes(d.id)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}</td>
            <td className="text-xs">{i.reminderCount}{i.lastRemindedOn ? ` · ${formatDate(i.lastRemindedOn)}` : ''}</td></tr>
        ))}</tbody>
      </table></div>}
    </div>
  );
}

function UdinPanel({ e }: { e: EngagementDetail }) {
  const t = useT();
  const can = useCan();
  const err = useP8Error();
  const qc = useQueryClient();
  const docs = useClientDocs(e.clientId).data ?? [];
  const [udin, setUdin] = useState('');
  const [mno, setMno] = useState('');
  const [on, setOn] = useState(todayIst());
  const [docType, setDocType] = useState('Audit report');
  const [docId, setDocId] = useState('');
  const [partner, setPartner] = useState<string | null>(e.partnerId);
  const [touched, setTouched] = useState(false);
  const why = udinInputError(udin, mno, on, todayIst());
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p8'] });
  const rec = useMutation({
    mutationFn: () => as<{ id: string }>(api.POST('/audit/udins', { body: body({ clientId: e.clientId, engagementId: e.id, taskId: e.taskId, udin: normalizeUdin(udin), documentType: docType.trim(),
      generatedOn: on, membershipNo: mno, signingPartnerId: partner, documentId: docId || null }) })),
    onSuccess: () => { setUdin(''); setTouched(false); toast({ text: t('p8.u.recorded'), tone: 'ok' }); refresh(); },
    onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  const revoke = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => as(api.POST('/audit/udins/{id}/revoke', { params: { path: { id } }, body: body({ reason }) })),
    onSuccess: refresh, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="card space-y-2 p-3" aria-label={t('p8.u.record')}>
        <h2 className="font-medium">{t('p8.u.record')}</h2>
        <p className="text-sm text-muted">{t('p8.u.explain')}</p>
        <a className="btn inline-flex" href={e.udinPortalUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} aria-hidden /> {t('p8.u.portal')}</a>
        {can('audit', 'edit') && <form className="space-y-2" onSubmit={(ev) => { ev.preventDefault(); setTouched(true); if (!why) rec.mutate(); }}>
          <Field label="UDIN" error={touched && why ? t(`p8.udin.err.${why}` as never) : null} hint={t('p8.u.formatHint')}>
            <input className="input font-mono uppercase" maxLength={22} autoComplete="off" value={udin} onChange={(ev) => setUdin(ev.target.value)} onBlur={() => setTouched(true)} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('p8.u.membership')}><input className="input font-mono" inputMode="numeric" maxLength={6} value={mno} onChange={(ev) => setMno(ev.target.value.replace(/\D/g, ''))} /></Field>
            <Field label={t('p8.u.generatedOn')}><input type="date" className="input" max={todayIst()} value={on} onChange={(ev) => setOn(ev.target.value)} /></Field>
          </div>
          <Field label={t('p8.u.docType')}><input className="input" value={docType} onChange={(ev) => setDocType(ev.target.value)} required /></Field>
          <PersonSelect label={t('p8.u.signingPartner')} value={partner} onChange={setPartner} />
          <Field label={t('p8.u.document')}><select className="input" value={docId} onChange={(ev) => setDocId(ev.target.value)}><option value="">—</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <button className="btn btn-primary" disabled={rec.isPending}>{t('p8.u.save')}</button>
        </form>}
      </section>
      <section className="card p-3" aria-label={t('p8.u.list')}>
        <h2 className="mb-2 font-medium">{t('p8.u.list')}</h2>
        {!e.udins.length && <p className="text-sm text-muted">{t('p8.u.none')}</p>}
        <ul className="space-y-1 text-sm">{e.udins.map((u: Udin) => (
          <li key={u.id} className={u.revokedAt ? 'text-muted line-through' : ''}><span className="font-mono">{u.udin}</span> · {u.documentType} · {formatDate(u.generatedOn)}
            {u.revokedAt ? <span className="ml-1 no-underline">({t('p8.u.revoked')}{u.revokeReason ? `: ${u.revokeReason}` : ''})</span>
              : can('audit', 'approve') && <button className="btn ml-2" onClick={() => { const r = prompt(t('p8.u.revokeReason')); if (r?.trim()) revoke.mutate({ id: u.id, reason: r.trim() }); }}>{t('p8.u.revoke')}</button>}</li>
        ))}</ul>
      </section>
    </div>
  );
}
