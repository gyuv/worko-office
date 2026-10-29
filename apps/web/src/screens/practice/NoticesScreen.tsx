import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NOTICE_AUTHORITY_KEYS, NOTICE_OUTCOMES, NOTICE_STATUSES, type NoticeOutcome, type NoticeStatus } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { ArrowLeft, FileUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { multipart, todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { isUuid, useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { Money, RupeeInput } from '../billing/shared';
import { paiseToInput, parseRupees } from '../billing/logic';
import { PersonSelect, useUsers } from '../tasks/shared';
import { TaskDrawer } from '../tasks/TaskDrawer';
import { as, body, openDoc, uploadDoc, useP8Error, useP8Label, type Ageing, type Extraction, type Hearing, type Notice, type NoticeDetail } from './api';
import {
  acceptAll, allowedTransitions, confirmFields, draftError, draftsFrom, editDraft, isNoticeOverdue, isoToIstInput, istInputToIso, levelsOf, matchOnly, toggleDraft, type FieldDraft,
} from './logic';

type View = 'list' | 'ageing';

export function NoticesScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  if (!can('notices', 'view')) return <p className="card p-6 text-muted">{t('p8.noAccess')}</p>;
  if (isUuid(params[0])) return <NoticeView id={params[0]} />;
  const view: View = params[0] === 'ageing' ? 'ageing' : 'list';
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{t('p8.nav.notices')}</h1>
        {can('notices', 'create') && <div className="ml-auto flex gap-2">
          <button className="btn" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t('p8.n.new')}</button>
          <button className="btn btn-primary" onClick={() => setUploading(true)}><FileUp size={14} aria-hidden /> {t('p8.n.upload')}</button>
        </div>}</header>
      <Tabs<View> label={t('p8.nav.notices')} value={view} onChange={(v) => go(v === 'list' ? 'notices' : 'notices/ageing')} tabs={[['list', t('p8.n.list')], ['ageing', t('p8.n.ageing')]]} />
      {view === 'list' ? <NoticeList /> : <AgeingView />}
      {uploading && <UploadNotice onClose={() => setUploading(false)} onDone={(id) => { setUploading(false); go(`notices/${id}`); }} />}
      {creating && <NewNotice onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); go(`notices/${id}`); }} />}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { received: 'text-primary', under_review: 'text-primary', drafting: 'text-due-soon', submitted: 'text-done', hearing: 'text-due-soon', closed: 'text-muted' };
export function NoticeStatusPill({ status }: { status: string }) {
  const label = useP8Label();
  return <span className={`rounded bg-surface-alt px-1.5 py-0.5 text-xs ${STATUS_TONE[status] ?? ''}`}>{label('nstatus', status)}</span>;
}

/** Notices table; with `clientId` it is the Client 360 tab. */
export function NoticeList({ clientId }: { clientId?: string }) {
  const t = useT();
  const label = useP8Label();
  const [client, setClient] = useState<PickedClient | null>(null);
  const [authority, setAuthority] = useState('');
  const [status, setStatus] = useState('');
  const [level, setLevel] = useState('');
  const [overdue, setOverdue] = useState(false);
  const cid = clientId ?? client?.id;
  const query = { ...(cid ? { clientId: cid } : {}), ...(authority ? { authority } : {}), ...(status ? { status } : {}), ...(overdue ? { overdue: 'true' } : {}), limit: 200 };
  const q = useQuery({ queryKey: ['p8', 'notices', query], queryFn: () => as<{ total: number; items: Notice[] }>(api.GET('/notices', { params: { query: query as never } })) });
  const today = todayIst();
  const items = (q.data?.items ?? []).filter((n) => !level || n.level === level);
  const levels = authority ? levelsOf(authority) : [...new Set((q.data?.items ?? []).map((n) => n.level))];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        {!clientId && <div className="w-60"><ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} /></div>}
        <Field label={t('p8.f.authority')}><select className="input" value={authority} onChange={(e) => { setAuthority(e.target.value); setLevel(''); }}>
          <option value="">{t('p8.all')}</option>{NOTICE_AUTHORITY_KEYS.map((a) => <option key={a} value={a}>{label('auth', a)}</option>)}</select></Field>
        <Field label={t('p8.f.status')}><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('p8.all')}</option>{NOTICE_STATUSES.map((s) => <option key={s} value={s}>{label('nstatus', s)}</option>)}</select></Field>
        <Field label={t('p8.f.level')}><select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">{t('p8.all')}</option>{levels.map((l) => <option key={l} value={l}>{label('level', l)}</option>)}</select></Field>
        <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> {t('p8.n.overdueOnly')}</label>
      </div>
      {q.data && !items.length && <p className="card p-6 text-muted">{t('p8.n.none')}</p>}
      {!!items.length && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p8.nav.notices')}>
        <thead><tr><th>{t('p8.f.title')}</th>{!clientId && <th>{t('p8.f.client')}</th>}<th>{t('p8.f.authority')}</th><th>{t('p8.f.level')}</th><th>{t('p8.f.responseDue')}</th><th className="text-right">{t('p8.f.demand')}</th><th>{t('p8.f.status')}</th></tr></thead>
        <tbody>{items.map((n) => (
          <tr key={n.id}><td><a className="underline-offset-2 hover:underline" href={`#/notices/${n.id}`}>{n.title}</a>{n.section && <span className="block text-xs text-muted">u/s {n.section}{n.din ? ` · DIN ${n.din}` : ''}</span>}</td>
            {!clientId && <td>{n.clientName}</td>}<td>{label('auth', n.authority)}</td><td>{label('level', n.level)}</td>
            <td className={isNoticeOverdue(n, today) ? 'text-overdue' : ''}>{n.responseDue ? formatDate(n.responseDue) : '—'}{isNoticeOverdue(n, today) && <span className="block text-xs">{t('p8.n.overdue')}</span>}</td>
            <td className="text-right"><Money p={n.demandPaise} /></td><td><NoticeStatusPill status={n.status} /></td></tr>
        ))}</tbody>
      </table></div>}
    </div>
  );
}

function AgeingView() {
  const t = useT();
  const label = useP8Label();
  const q = useQuery({ queryKey: ['p8', 'ageing'], queryFn: () => as<Ageing>(api.GET('/notices/reports/ageing', { params: { query: {} } })) });
  const a = q.data;
  if (!a) return <p className="text-muted">{t('common.loading')}</p>;
  return (
    <div className="space-y-3">
      <ul className="grid gap-2 sm:grid-cols-3">
        <li className="card p-3"><div className="text-sm text-muted">{t('p8.n.open')}</div><div className="text-2xl font-semibold" data-testid="ageing-open">{a.open}</div></li>
        <li className="card p-3"><div className="text-sm text-muted">{t('p8.n.overdue')}</div><div className="text-2xl font-semibold text-overdue">{a.overdue}</div></li>
        <li className="card p-3"><div className="text-sm text-muted">{t('p8.n.demandTotal')}</div><div className="text-2xl font-semibold"><Money p={a.demandPaise} /></div></li>
      </ul>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p8.n.buckets')}>
        <thead><tr><th>{t('p8.n.age')}</th><th className="text-right">{t('p8.n.count')}</th><th className="text-right">{t('p8.f.demand')}</th></tr></thead>
        <tbody>{a.buckets.map((b) => <tr key={b.bucket}><td>{t('p8.n.days', { range: b.bucket })}</td><td className="text-right">{b.count}</td><td className="text-right"><Money p={b.demandPaise} /></td></tr>)}</tbody>
      </table></div>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p8.n.byAuthority')}>
        <thead><tr><th>{t('p8.f.authority')}</th><th>{t('p8.f.level')}</th><th className="text-right">{t('p8.n.count')}</th><th className="text-right">{t('p8.f.demand')}</th></tr></thead>
        <tbody>{a.byAuthority.map((b) => <tr key={`${b.authority}|${b.level}`}><td>{label('auth', b.authority)}</td><td>{label('level', b.level)}</td><td className="text-right">{b.count}</td><td className="text-right"><Money p={b.demandPaise} /></td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

function NewNotice({ onClose, onDone, clientFixed }: { onClose(): void; onDone(id: string): void; clientFixed?: PickedClient }) {
  const t = useT();
  const err = useP8Error();
  const label = useP8Label();
  const qc = useQueryClient();
  const [client, setClient] = useState<PickedClient | null>(clientFixed ?? null);
  const [authority, setAuthority] = useState<string>('income_tax');
  const [title, setTitle] = useState('');
  const [section, setSection] = useState('');
  const [responseDue, setDue] = useState('');
  const [demand, setDemand] = useState('');
  const m = useMutation({
    mutationFn: () => as<{ id: string }>(api.POST('/notices', { body: body({ clientId: client!.id, authority, title: title.trim(), section: section.trim() || null, responseDue: responseDue || null,
      demandPaise: demand ? parseRupees(demand) ?? 0 : 0, createTask: true }) })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['p8'] }); onDone(r.id); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p8.n.new')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (client && title.trim()) m.mutate(); }}>
        <ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} />
        <Field label={t('p8.f.authority')}><select className="input" value={authority} onChange={(e) => setAuthority(e.target.value)}>
          {NOTICE_AUTHORITY_KEYS.map((a) => <option key={a} value={a}>{label('auth', a)}</option>)}</select></Field>
        <Field label={t('p8.f.title')}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('p8.f.section')}><input className="input" value={section} onChange={(e) => setSection(e.target.value)} /></Field>
          <Field label={t('p8.f.responseDue')}><input type="date" className="input" value={responseDue} onChange={(e) => setDue(e.target.value)} /></Field>
          <div><span className="label">{t('p8.f.demand')}</span><RupeeInput label={t('p8.f.demand')} value={demand} onChange={setDemand} /></div>
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!client || !title.trim() || m.isPending}>{t('p8.create')}</button></div>
      </form>
    </Dialog>
  );
}

/** Upload → extraction suggestions side by side → user accepts/edits per field → confirm (only accepted fields) or discard. */
export function UploadNotice({ onClose, onDone, noticeId, client: fixed }: { onClose(): void; onDone(noticeId: string): void; noticeId?: string; client?: PickedClient }) {
  const t = useT();
  const err = useP8Error();
  const label = useP8Label();
  const qc = useQueryClient();
  const [client, setClient] = useState<PickedClient | null>(fixed ?? null);
  const [file, setFile] = useState<File | null>(null);
  const [ext, setExt] = useState<Extraction | null>(null);
  const [drafts, setDrafts] = useState<FieldDraft[]>([]);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => as<Extraction>(api.POST('/notices/extract', { body: multipart({ file: file!, clientId: client!.id, noticeId }) })),
    onSuccess: (x) => { setExt(x); setDrafts(draftsFrom(x.suggestions)); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const fields = confirmFields(drafts);
  const bad = drafts.some((d) => draftError(d));
  const confirm = useMutation({
    mutationFn: () => as<{ noticeId: string }>(api.POST('/notices/extractions/{id}/confirm', { params: { path: { id: ext!.id } },
      body: body({ fields, ...(title.trim() ? { title: title.trim() } : {}), ...(noticeId ? {} : { assigneeId: assignee }) }) })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['p8'] }); toast({ text: t('p8.x.confirmed'), tone: 'ok' }); onDone(r.noticeId); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const discard = useMutation({
    mutationFn: () => as(api.POST('/notices/extractions/{id}/discard', { params: { path: { id: ext!.id } } })),
    onSuccess: () => { toast({ text: t('p8.x.discarded'), tone: 'ok' }); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const needAuthority = !noticeId && !('authority' in fields);
  return (
    <Dialog title={noticeId ? t('p8.x.titleUpdate') : t('p8.n.upload')} onClose={onClose} wide>
      {!ext ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (client && file) run.mutate(); }}>
          {!fixed && <ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} />}
          <Field label={t('p8.x.file')} hint={t('p8.x.fileHint')}><input type="file" className="input" accept="application/pdf,text/plain,.pdf,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-primary" disabled={!client || !file || run.isPending}>{run.isPending ? t('p8.x.reading') : t('p8.x.extract')}</button></div>
        </form>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!bad && !needAuthority) confirm.mutate(); }}>
          <p className="text-sm text-muted">{t('p8.x.intro', { provider: ext.provider })}</p>
          {!ext.suggestions.length && <p role="status" className="rounded bg-surface-alt p-2 text-sm">{t('p8.x.nothing')}</p>}
          <div className="overflow-auto"><table className="table w-full" aria-label={t('p8.x.fields')}>
            <thead><tr><th>{t('p8.x.field')}</th><th>{t('p8.x.suggested')}</th><th>{t('p8.x.yourValue')}</th><th>{t('p8.x.accept')}</th></tr></thead>
            <tbody>{drafts.map((d) => {
              const e = draftError(d);
              const name = t(`p8.xf.${d.field}`);
              return (
                <tr key={d.field} data-testid={`x-${d.field}`}>
                  <td>{name}</td>
                  <td>{d.suggested ? <><span className="font-mono">{d.field === 'authority' ? label('auth', d.suggested) : d.suggested}</span>
                    <span className="ml-1 text-xs text-muted">{t('p8.x.confidence', { pct: Math.round((d.confidence ?? 0) * 100) })}</span>
                    {d.source && <span className="block max-w-xs truncate text-xs text-muted" title={d.source}>“{d.source}”</span>}</> : <span className="text-muted">—</span>}</td>
                  <td>{d.field === 'authority'
                    ? <select className="input" aria-label={name} value={d.value} onChange={(ev) => setDrafts(editDraft(drafts, d.field, ev.target.value))}>
                      <option value="">—</option>{NOTICE_AUTHORITY_KEYS.map((a) => <option key={a} value={a}>{label('auth', a)}</option>)}</select>
                    : <input className={`input ${e ? 'border-overdue' : ''}`} aria-label={name} aria-invalid={!!e} value={d.value}
                      placeholder={d.field.endsWith('Date') || d.field === 'responseDue' ? 'YYYY-MM-DD' : d.field.endsWith('Year') ? 'YYYY-YY' : ''}
                      onChange={(ev) => setDrafts(editDraft(drafts, d.field, ev.target.value))} />}
                    {e && <span role="alert" className="block text-xs text-overdue">{t(`p8.x.err.${e}` as never)}</span>}</td>
                  <td><input type="checkbox" aria-label={t('p8.x.acceptField', { field: name })} checked={d.accepted} disabled={!d.value.trim()} onChange={(ev) => setDrafts(toggleDraft(drafts, d.field, ev.target.checked))} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {matchOnly(ext.suggestions).length > 0 && <p className="text-xs text-muted">{t('p8.x.matchOnly')}: {matchOnly(ext.suggestions).map((s) => `${s.field.toUpperCase()} ${s.value}`).join(', ')}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('p8.f.title')} hint={t('p8.x.titleHint')}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            {!noticeId && <PersonSelect label={t('p8.f.assignee')} value={assignee} onChange={setAssignee} />}
          </div>
          {needAuthority && <p role="alert" className="text-sm text-due-soon">{t('p8.x.needAuthority')}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn" onClick={() => setDrafts(acceptAll(drafts))}>{t('p8.x.acceptAll')}</button>
            <button type="button" className="btn btn-danger" onClick={() => discard.mutate()} disabled={discard.isPending}>{t('p8.x.discard')}</button>
            <button className="btn btn-primary" disabled={bad || needAuthority || confirm.isPending}>{t('p8.x.confirm', { count: Object.keys(fields).length })}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function NoticeView({ id }: { id: string }) {
  const t = useT();
  const can = useCan();
  const err = useP8Error();
  const label = useP8Label();
  const qc = useQueryClient();
  const { name } = useUsers();
  const q = useQuery({ queryKey: ['p8', 'notice', id], retry: false, queryFn: () => as<NoticeDetail>(api.GET('/notices/{id}', { params: { path: { id } } })) });
  const [closing, setClosing] = useState(false);
  const [task, setTask] = useState<string | null>(null);
  const [reExtract, setReExtract] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p8'] });
  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) => as(api.PATCH('/notices/{id}', { params: { path: { id } }, body: body(b) })),
    onSuccess: refresh, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const move = useMutation({
    mutationFn: (b: { status: NoticeStatus; outcome?: NoticeOutcome; outcomeNote?: string | null; finalDemandPaise?: number | null }) => as(api.POST('/notices/{id}/status', { params: { path: { id } }, body: body(b) })),
    onSuccess: () => { refresh(); setClosing(false); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  if (q.isError) return <div role="alert" className="card p-6">{t('p8.notFound')} <a className="underline" href="#/notices">{t('p8.nav.notices')}</a></div>;
  const n = q.data;
  if (!n) return <p className="text-muted">{t('common.loading')}</p>;
  const editable = can('notices', 'edit') && n.status !== 'closed';
  const today = todayIst();
  return (
    <div className="space-y-3">
      <a href="#/notices" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('p8.nav.notices')}</a>
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">{n.title}</h1>
          <p className="text-sm text-muted"><a className="underline" href={`#/clients/${n.clientId}`}>{n.clientName}</a> · {label('auth', n.authority)} · {label('level', n.level)}</p></div>
        <NoticeStatusPill status={n.status} />
      </header>
      {editable && <div className="flex flex-wrap gap-2" role="group" aria-label={t('p8.n.moveTo')}>
        {allowedTransitions(n.status).map((s) => (
          <button key={s} className={`btn ${s === 'closed' ? 'btn-danger' : ''}`} disabled={move.isPending}
            onClick={() => (s === 'closed' ? setClosing(true) : move.mutate({ status: s }))}>{t('p8.n.moveTo')}: {label('nstatus', s)}</button>
        ))}
      </div>}
      {n.status === 'closed' && <p className="card p-3 text-sm">{t('p8.n.closedWith', { outcome: label('outcome', n.outcome) })}{n.outcomeNote ? ` — ${n.outcomeNote}` : ''}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="card space-y-2 p-3" aria-label={t('p8.n.details')}>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">{t('p8.f.section')}</dt><dd>{n.section ?? '—'}</dd>
            <dt className="text-muted">DIN</dt><dd className="font-mono">{n.din ?? '—'}</dd>
            <dt className="text-muted">{t('p8.f.reference')}</dt><dd>{n.referenceNo ?? '—'}</dd>
            <dt className="text-muted">{t('p8.f.ay')}</dt><dd>{n.assessmentYear ?? '—'}</dd>
            <dt className="text-muted">{t('p8.f.issueDate')}</dt><dd>{n.issueDate ? formatDate(n.issueDate) : '—'}</dd>
            <dt className="text-muted">{t('p8.f.receivedOn')}</dt><dd>{formatDate(n.receivedOn)}</dd>
            <dt className="text-muted">{t('p8.f.responseDue')}</dt><dd className={isNoticeOverdue(n, today) ? 'text-overdue' : ''}>{n.responseDue ? formatDate(n.responseDue) : '—'}</dd>
            <dt className="text-muted">{t('p8.f.demand')}</dt><dd><Money p={n.demandPaise} />{n.finalDemandPaise !== null && <span className="text-xs text-muted"> → <Money p={n.finalDemandPaise} /></span>}</dd>
          </dl>
          {editable ? <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('p8.f.level')}><select className="input" value={n.level} onChange={(e) => patch.mutate({ level: e.target.value })}>
              {levelsOf(n.authority).map((l) => <option key={l} value={l}>{label('level', l)}</option>)}</select></Field>
            <Field label={t('p8.f.responseDue')}><input type="date" className="input" defaultValue={n.responseDue ?? ''} onBlur={(e) => e.target.value !== (n.responseDue ?? '') && patch.mutate({ responseDue: e.target.value || null })} /></Field>
            <div><span className="label">{t('p8.f.demand')}</span><DemandEdit value={n.demandPaise} onSave={(p) => patch.mutate({ demandPaise: p })} /></div>
            <PersonSelect label={t('p8.f.assignee')} value={n.assigneeId} onChange={(v) => patch.mutate({ assigneeId: v })} />
            <PersonSelect label={t('p8.f.reviewer')} value={n.reviewerId} onChange={(v) => patch.mutate({ reviewerId: v })} />
          </div> : <p className="text-sm">{t('p8.f.assignee')}: {name(n.assigneeId)} · {t('p8.f.reviewer')}: {name(n.reviewerId)}</p>}
          {n.taskId && <button className="btn" onClick={() => setTask(n.taskId)}>{t('p8.n.openTask')}</button>}
          {n.appealOf && <a className="block text-sm underline" href={`#/notices/${n.appealOf}`}>{t('p8.n.appealOf')}</a>}
        </section>
        <NoticeDocuments n={n} editable={editable} onReExtract={() => setReExtract(true)} />
      </div>
      <Hearings n={n} editable={editable} />
      {closing && <CloseNotice n={n} onClose={() => setClosing(false)} onSubmit={(b) => move.mutate({ status: 'closed', ...b })} />}
      {task && <TaskDrawer id={task} onClose={() => setTask(null)} />}
      {reExtract && <UploadNotice noticeId={n.id} client={{ id: n.clientId, name: n.clientName ?? '' }} onClose={() => setReExtract(false)} onDone={() => { setReExtract(false); refresh(); }} />}
    </div>
  );
}

function DemandEdit({ value, onSave }: { value: number; onSave(p: number): void }) {
  const t = useT();
  const [v, setV] = useState(paiseToInput(value));
  return <div className="flex gap-1"><RupeeInput label={t('p8.f.demand')} value={v} onChange={setV} />
    <button className="btn" type="button" disabled={parseRupees(v) === null || parseRupees(v) === value} onClick={() => onSave(parseRupees(v)!)}>{t('common.save')}</button></div>;
}

function CloseNotice({ n, onClose, onSubmit }: { n: Notice; onClose(): void; onSubmit(b: { outcome: NoticeOutcome; outcomeNote: string | null; finalDemandPaise: number | null }): void }) {
  const t = useT();
  const label = useP8Label();
  const [outcome, setOutcome] = useState<NoticeOutcome>('dropped');
  const [note, setNote] = useState('');
  const [fd, setFd] = useState(paiseToInput(n.demandPaise));
  return (
    <Dialog title={t('p8.n.close')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ outcome, outcomeNote: note.trim() || null, finalDemandPaise: outcome === 'dropped' ? 0 : parseRupees(fd) }); }}>
        <Field label={t('p8.n.outcome')}><select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value as NoticeOutcome)}>
          {NOTICE_OUTCOMES.map((o) => <option key={o} value={o}>{label('outcome', o)}</option>)}</select></Field>
        {outcome !== 'dropped' && <div><span className="label">{t('p8.n.finalDemand')}</span><RupeeInput label={t('p8.n.finalDemand')} value={fd} onChange={setFd} /></div>}
        <Field label={t('p8.f.note')}><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {outcome === 'appeal' && <p className="text-xs text-muted">{t('p8.n.appealHint')}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-danger">{t('p8.n.close')}</button></div>
      </form>
    </Dialog>
  );
}

function NoticeDocuments({ n, editable, onReExtract }: { n: NoticeDetail; editable: boolean; onReExtract(): void }) {
  const t = useT();
  const err = useP8Error();
  const label = useP8Label();
  const qc = useQueryClient();
  const [kind, setKind] = useState('reply');
  const up = useMutation({
    mutationFn: async (f: File) => {
      const d = await uploadDoc({ file: f, clientId: n.clientId, category: 'Notices' });
      await as(api.POST('/notices/{id}/documents', { params: { path: { id: n.id } }, body: body({ documentId: d.id, kind }) }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['p8', 'notice', n.id] }); toast({ text: t('p8.n.uploaded'), tone: 'ok' }); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <section className="card space-y-2 p-3" aria-label={t('p8.n.documents')}>
      <h2 className="font-medium">{t('p8.n.documents')}</h2>
      {!n.documents.length && <p className="text-sm text-muted">{t('p8.n.noDocs')}</p>}
      <ul className="space-y-1 text-sm">{n.documents.map((d) => (
        <li key={d.documentId} className="flex items-center gap-2"><span className="rounded bg-surface-alt px-1 text-xs">{label('dkind', d.kind)}</span>
          <button className="truncate underline-offset-2 hover:underline" onClick={() => void openDoc(d.documentId)}>{d.name}</button><span className="text-xs text-muted">v{d.currentVersion}</span></li>
      ))}</ul>
      {editable && <div className="flex flex-wrap items-end gap-2">
        <Field label={t('p8.n.docKind')}><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {['reply', 'order', 'evidence', 'notice', 'other'].map((k) => <option key={k} value={k}>{label('dkind', k)}</option>)}</select></Field>
        <label className="btn cursor-pointer"><FileUp size={14} aria-hidden /> {t('p8.n.uploadReply')}
          <input type="file" className="sr-only" aria-label={t('p8.n.uploadReply')} onChange={(e) => { const f = e.target.files?.[0]; if (f) up.mutate(f); e.target.value = ''; }} /></label>
        <button className="btn" onClick={onReExtract}>{t('p8.x.titleUpdate')}</button>
      </div>}
    </section>
  );
}

function Hearings({ n, editable }: { n: NoticeDetail; editable: boolean }) {
  const t = useT();
  const err = useP8Error();
  const label = useP8Label();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [adjourning, setAdjourning] = useState<Hearing | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p8', 'notice', n.id] });
  const upd = useMutation({
    mutationFn: ({ id, b }: { id: string; b: Record<string, unknown> }) => as(api.PATCH('/notices/hearings/{id}', { params: { path: { id } }, body: body(b) })),
    onSuccess: refresh, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <section className="card space-y-2 p-3" aria-label={t('p8.h.title')}>
      <div className="flex items-center"><h2 className="font-medium">{t('p8.h.title')}</h2>
        {editable && <button className="btn ml-auto" onClick={() => setAdding(true)}><Plus size={14} aria-hidden /> {t('p8.h.add')}</button>}</div>
      {!n.hearings.length && <p className="text-sm text-muted">{t('p8.h.none')}</p>}
      {!!n.hearings.length && <table className="table w-full" aria-label={t('p8.h.title')}>
        <thead><tr><th>{t('p8.h.when')}</th><th>{t('p8.h.venue')}</th><th>{t('p8.f.status')}</th><th>{t('p8.h.prep')}</th><th /></tr></thead>
        <tbody>{n.hearings.map((h) => (
          <tr key={h.id} className={h.status === 'adjourned' || h.status === 'cancelled' ? 'text-muted' : ''}>
            <td>{formatDateTime(h.startsAt)}{h.adjournedFrom && <span className="block text-xs text-muted">{t('p8.h.adjournedFrom')}{h.adjournmentReason ? `: ${h.adjournmentReason}` : ''}</span>}</td>
            <td>{h.venue}{h.virtualLink && <a className="block text-xs underline" href={h.virtualLink} target="_blank" rel="noreferrer">{t('p8.h.link')}</a>}</td>
            <td>{label('hstatus', h.status)}{h.outcomeNote && <span className="block text-xs">{h.outcomeNote}</span>}</td>
            <td><input type="checkbox" aria-label={t('p8.h.prep')} checked={h.prepDone} disabled={!editable || h.status !== 'scheduled'} onChange={(e) => upd.mutate({ id: h.id, b: { prepDone: e.target.checked } })} /></td>
            <td className="space-x-1 text-right">{editable && h.status === 'scheduled' && <>
              <button className="btn" onClick={() => { const note = prompt(t('p8.h.outcomePrompt')); if (note !== null) upd.mutate({ id: h.id, b: { status: 'held', outcomeNote: note || null } }); }}>{t('p8.h.held')}</button>
              <button className="btn" onClick={() => setAdjourning(h)}>{t('p8.h.adjourn')}</button>
              <button className="btn" onClick={() => upd.mutate({ id: h.id, b: { status: 'cancelled' } })}>{t('common.cancel')}</button></>}</td>
          </tr>
        ))}</tbody>
      </table>}
      {adding && <HearingDialog title={t('p8.h.add')} onClose={() => setAdding(false)} submit={(b) => as(api.POST('/notices/{id}/hearings', { params: { path: { id: n.id } }, body: body(b) }))} onDone={refresh} />}
      {adjourning && <HearingDialog title={t('p8.h.adjourn')} adjourn initial={adjourning} onClose={() => setAdjourning(null)}
        submit={(b) => as(api.POST('/notices/hearings/{id}/adjourn', { params: { path: { id: adjourning.id } }, body: body(b) }))} onDone={refresh} />}
    </section>
  );
}

function HearingDialog({ title, onClose, submit, onDone, adjourn, initial }: { title: string; onClose(): void; submit(b: Record<string, unknown>): Promise<unknown>; onDone(): void; adjourn?: boolean; initial?: Hearing }) {
  const t = useT();
  const err = useP8Error();
  const [starts, setStarts] = useState(initial ? isoToIstInput(initial.startsAt) : '');
  const [venue, setVenue] = useState(initial?.venue ?? '');
  const [link, setLink] = useState(initial?.virtualLink ?? '');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => submit({ startsAt: istInputToIso(starts), venue: venue.trim() || null, virtualLink: link.trim() || null, ...(adjourn ? { reason: reason.trim() || null } : {}) }),
    onSuccess: () => { onDone(); onClose(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (starts) m.mutate(); }}>
        <Field label={adjourn ? t('p8.h.newWhen') : t('p8.h.when')}><input type="datetime-local" className="input" value={starts} onChange={(e) => setStarts(e.target.value)} required /></Field>
        <Field label={t('p8.h.venue')}><input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} /></Field>
        <Field label={t('p8.h.link')}><input className="input" type="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} /></Field>
        {adjourn && <Field label={t('p8.h.reason')}><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={!starts || m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

/** Client 360 → Notices tab. */
export function ClientNoticesTab({ clientId, clientName }: { clientId: string; clientName: string }) {
  const t = useT();
  const can = useCan();
  const go = useRoute((s) => s.go);
  const [uploading, setUploading] = useState(false);
  return (
    <div className="space-y-2">
      {can('notices', 'create') && <div className="flex justify-end"><button className="btn" onClick={() => setUploading(true)}><FileUp size={14} aria-hidden /> {t('p8.n.upload')}</button></div>}
      <NoticeList clientId={clientId} />
      {uploading && <UploadNotice client={{ id: clientId, name: clientName }} onClose={() => setUploading(false)} onDone={(id) => go(`notices/${id}`)} />}
    </div>
  );
}
