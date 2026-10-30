import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { reportScheduleSchema, type ReportSchedule } from '@worko/domain';
import { Download, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MessageKey } from '@worko/i18n';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { fetchBlob, saveBlob } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { api } from '../../lib/session';
import { useUsers } from '../tasks/shared';
import { as, asFull, body, useCatalogue, useSaved, useSchedules, type Schedule, type ScheduleRun } from './api';
import { exportDownloadError, fmtIstDateTime, schedulePreview, WEEKDAYS } from './logic';
import { useReportError } from './ResultView';

/** Scheduled reports: IST schedule with next-run preview, recipients, format; run history per recipient; paused → resume. */
export function SchedulesView() {
  const t = useT();
  const can = useCan();
  const err = useReportError();
  const qc = useQueryClient();
  const q = useSchedules();
  const [edit, setEdit] = useState<Schedule | 'new' | null>(null);
  const [runs, setRuns] = useState<Schedule | null>(null);
  const toggle = useMutation({
    mutationFn: (s: Schedule) => asFull(api.PUT('/reports/schedules/{id}', { params: { path: { id: s.id } }, body: body({ enabled: !(s.enabled && s.status !== 'paused') }) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports', 'schedules'] }),
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const remove = useMutation({
    mutationFn: (s: Schedule) => asFull(api.DELETE('/reports/schedules/{id}', { params: { path: { id: s.id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports', 'schedules'] }),
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <div className="space-y-2" data-testid="schedules">
      <div className="flex items-center justify-between"><p className="text-sm text-muted">{t('p11.s.intro')}</p>
        {can('reports', 'create') && <button type="button" className="btn btn-primary" onClick={() => setEdit('new')}><Plus size={12} aria-hidden />{t('p11.s.new')}</button>}</div>
      {q.isError && <p role="alert" className="text-overdue">{err(q.error)}</p>}
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p11.tab.schedules')}>
        <thead><tr><th>{t('p11.f.name')}</th><th>{t('p11.s.when')}</th><th>{t('p11.s.next')}</th><th>{t('p11.s.format')}</th><th>{t('p11.s.status')}</th><th /></tr></thead>
        <tbody>
          {q.data && !q.data.length && <tr><td colSpan={6} className="text-muted">{t('p11.s.empty')}</td></tr>}
          {(q.data ?? []).map((s) => {
            const paused = s.status === 'paused';
            const on = s.enabled && !paused;
            return (
              <tr key={s.id} data-testid={`schedule-${s.id}`}>
                <td><button type="button" className="underline" onClick={() => setEdit(s)}>{s.name}</button></td>
                <td className="text-sm">{safePreview(s.schedule)?.text ?? '—'}</td>
                <td className="text-sm tabular-nums">{on && s.nextRunAt ? `${fmtIstDateTime(s.nextRunAt)} IST` : '—'}</td>
                <td className="uppercase">{s.format}</td>
                <td>{paused ? <span className="text-overdue" data-testid="paused">{t('p11.s.paused')}{s.pausedReason ? ` — ${s.pausedReason}` : ''}</span> : on ? t('p11.s.active') : t('p11.s.disabled')}</td>
                <td className="whitespace-nowrap text-right">
                  <button type="button" className="btn" onClick={() => setRuns(s)}>{t('p11.s.history')}</button>{' '}
                  {can('reports', 'edit') && <button type="button" className="btn" onClick={() => toggle.mutate(s)}>{on ? <><Pause size={12} aria-hidden />{t('p11.s.pause')}</> : <><Play size={12} aria-hidden />{t('p11.s.resume')}</>}</button>}{' '}
                  {can('reports', 'edit') && <button type="button" className="btn btn-danger px-1.5" aria-label={t('p11.s.delete', { name: s.name })} onClick={() => remove.mutate(s)}><Trash2 size={12} /></button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {edit && <ScheduleEditor schedule={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {runs && <RunsDialog schedule={runs} onClose={() => setRuns(null)} />}
    </div>
  );
}
const safePreview = (s: unknown, now = new Date()) => { const p = reportScheduleSchema.safeParse(s); return p.success ? schedulePreview(p.data, now) : null; };

function ScheduleEditor({ schedule, onClose }: { schedule: Schedule | null; onClose(): void }) {
  const t = useT();
  const err = useReportError();
  const qc = useQueryClient();
  const me = useMe().data;
  const { users } = useUsers();
  const cat = useCatalogue().data ?? [];
  const saved = useSaved().data ?? [];
  const [name, setName] = useState(schedule?.name ?? '');
  const [source, setSource] = useState(schedule ? (schedule.reportId ? `saved:${schedule.reportId}` : `cat:${schedule.catalogueKey}`) : '');
  const [sch, setSch] = useState<ReportSchedule>(schedule?.schedule ?? { frequency: 'weekly', time: '08:00', weekday: 1, dayOfMonth: 1 });
  const [recipients, setRecipients] = useState<string[]>(schedule?.recipientIds ?? (me ? [me.id] : []));
  const [format, setFormat] = useState<Schedule['format']>(schedule?.format ?? 'xlsx');
  const [delivery, setDelivery] = useState<Schedule['delivery']>(schedule?.delivery ?? 'email');
  const [ttl, setTtl] = useState(schedule?.linkTtlDays ?? 7);
  const [error, setError] = useState<string | null>(null);
  const parsed = reportScheduleSchema.safeParse(sch);
  const preview = useMemo(() => (parsed.success ? schedulePreview(parsed.data, new Date()) : null), [parsed.success, sch]); // eslint-disable-line react-hooks/exhaustive-deps
  const people = me && !users.some((u) => u.id === me.id) ? [{ id: me.id, name: me.name }, ...users] : users;
  const m = useMutation({
    mutationFn: () => {
      const common = { name: name.trim(), schedule: sch, recipientIds: recipients, format, delivery, linkTtlDays: ttl };
      if (schedule) return asFull(api.PUT('/reports/schedules/{id}', { params: { path: { id: schedule.id } }, body: body(common) }));
      const [k, v] = source.split(':') as [string, string];
      return asFull(api.POST('/reports/schedules', { body: body({ ...common, ...(k === 'cat' ? { catalogueKey: v } : { reportId: v }) }) }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['reports', 'schedules'] }); toast({ text: t('p11.s.saved'), tone: 'ok' }); onClose(); },
    onError: (e) => setError(err(e)),
  });
  return (
    <Dialog title={schedule ? t('p11.s.editTitle') : t('p11.s.new')} onClose={onClose}>
      <form className="space-y-2" data-testid="schedule-editor" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label={t('p11.f.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label={t('p11.dash.report')}><select className="input" value={source} disabled={!!schedule} onChange={(e) => { setSource(e.target.value); if (!name) setName(e.target.selectedOptions[0]?.text ?? ''); }} required>
          <option value="">—</option>
          <optgroup label={t('p11.tab.catalogue')}>{cat.map((c) => <option key={c.key} value={`cat:${c.key}`}>{c.name}</option>)}</optgroup>
          {saved.length > 0 && <optgroup label={t('p11.tab.saved')}>{saved.map((s) => <option key={s.id} value={`saved:${s.id}`}>{s.name}</option>)}</optgroup>}
        </select></Field>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label={t('p11.s.frequency')}><select className="input" value={sch.frequency} onChange={(e) => setSch({ ...sch, frequency: e.target.value as ReportSchedule['frequency'] })}>
            {(['daily', 'weekly', 'monthly'] as const).map((f) => <option key={f} value={f}>{t(`p11.s.freq.${f}`)}</option>)}</select></Field>
          {sch.frequency === 'weekly' && <Field label={t('p11.s.weekday')}><select className="input" value={sch.weekday} onChange={(e) => setSch({ ...sch, weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></Field>}
          {sch.frequency === 'monthly' && <Field label={t('p11.s.day')}><input className="input" type="number" min={1} max={28} value={sch.dayOfMonth} onChange={(e) => setSch({ ...sch, dayOfMonth: Number(e.target.value) })} /></Field>}
          <Field label={t('p11.s.time')}><input className="input" type="time" value={sch.time} onChange={(e) => setSch({ ...sch, time: e.target.value })} /></Field>
        </div>
        <p className="text-sm" data-testid="schedule-preview">{preview ? <>{preview.text} · {t('p11.s.nextRun', { at: preview.nextText })}</> : <span className="text-overdue">{t('p11.s.invalid')}</span>}</p>
        <fieldset><legend className="label">{t('p11.s.recipients')}</legend>
          <div className="flex max-h-40 flex-wrap gap-2 overflow-auto">{people.map((u) => <label key={u.id} className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={recipients.includes(u.id)} onChange={() => setRecipients(recipients.includes(u.id) ? recipients.filter((x) => x !== u.id) : [...recipients, u.id])} />{u.name}</label>)}</div>
          <p className="text-xs text-muted">{t('p11.s.recipientsNote')}</p>
        </fieldset>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label={t('p11.s.format')}><select className="input" value={format} onChange={(e) => setFormat(e.target.value as Schedule['format'])}>{(['csv', 'xlsx', 'pdf'] as const).map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}</select></Field>
          <Field label={t('p11.s.delivery')}><select className="input" value={delivery} onChange={(e) => setDelivery(e.target.value as Schedule['delivery'])}><option value="email">{t('p11.s.email')}</option><option value="in_app">{t('p11.s.inApp')}</option></select></Field>
          <Field label={t('p11.s.ttl')}><input className="input" type="number" min={1} max={30} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} /></Field>
        </div>
        {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!parsed.success || !recipients.length || !source || !name.trim() || m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

function RunsDialog({ schedule, onClose }: { schedule: Schedule; onClose(): void }) {
  const t = useT();
  const skipLabel = (r: string) => { const k = `p11.s.skip.${r}` as MessageKey; const x = t(k); return x === k ? r.replace(/_/g, ' ') : x; };
  const q = useQuery({ queryKey: ['reports', 'schedules', schedule.id, 'runs'], queryFn: () => as<{ items: ScheduleRun[] }>(api.GET('/reports/schedules/{id}/runs', { params: { path: { id: schedule.id } } })).then((r) => r.items) });
  return (
    <Dialog wide title={t('p11.s.historyTitle', { name: schedule.name })} onClose={onClose}>
      <table className="table w-full text-sm" data-testid="schedule-runs">
        <thead><tr><th>{t('p11.s.period')}</th><th>{t('p11.s.recipient')}</th><th>{t('p11.s.status')}</th><th className="text-right">{t('p11.s.rows')}</th><th>{t('p11.s.at')}</th></tr></thead>
        <tbody>
          {q.data && !q.data.length && <tr><td colSpan={5} className="text-muted">{t('p11.s.noRuns')}</td></tr>}
          {(q.data ?? []).map((r) => <tr key={r.id}><td>{r.periodKey}</td><td>{r.recipientName ?? '—'}</td>
            <td className={r.status === 'failed' ? 'text-overdue' : r.status === 'delivered' ? 'text-done' : 'text-muted'}>{t(`p11.s.run.${r.status}`)}{r.skipReason ? ` — ${skipLabel(r.skipReason)}` : ''}{r.error ? ` — ${r.error}` : ''}</td>
            <td className="text-right tabular-nums">{r.rowCount ?? '—'}</td><td className="tabular-nums">{fmtIstDateTime(r.startedAt)}</td></tr>)}
        </tbody>
      </table>
    </Dialog>
  );
}

/** `#/reports/download/<token>`: the recipient (signed in) downloads a scheduled file; 404 = not yours, 410 = expired. */
export function DownloadPage({ token }: { token: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setState('busy'); setMsg(null);
    try { const f = await fetchBlob(`/reports/downloads/${encodeURIComponent(token)}`); saveBlob(f.blob, f.filename ?? 'report'); setState('done'); }
    catch (e) { setMsg(t(exportDownloadError(e))); setState('idle'); }
  };
  return (
    <div className="card max-w-lg space-y-3 p-6" data-testid="download-page">
      <h2 className="text-lg font-semibold">{t('p11.dl.title')}</h2>
      <p className="text-sm text-muted">{t('p11.dl.intro')} {t('p11.dl.rerender')}</p>
      <button type="button" className="btn btn-primary" disabled={state === 'busy'} onClick={() => void run()}><Download size={12} aria-hidden />{t('p11.dl.download')}</button>
      {state === 'done' && <p role="status" className="text-done">{t('p11.dl.done')}</p>}
      {msg && <p role="alert" className="text-overdue">{msg}</p>}
    </div>
  );
}

/** `report.ready` notification → GET /reports/exports/{id}/download (recipient only; re-rendered as the downloader, so rows can differ from the delivery). */
export function ReportExportDownload({ id }: { id: string }) {
  const t = useT();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setMsg(null);
    try { const f = await fetchBlob(`/reports/exports/${encodeURIComponent(id)}/download`); saveBlob(f.blob, f.filename ?? 'report'); }
    catch (e) { setMsg(t(exportDownloadError(e))); } finally { setBusy(false); }
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <button type="button" className="btn" disabled={busy} onClick={() => void run()}><Download size={12} aria-hidden />{t('p11.dl.download')}</button>
      <span className="text-xs text-muted">{t('p11.dl.rerender')}</span>
      {msg && <span role="alert" className="text-xs text-overdue">{msg}</span>}
    </div>
  );
}
