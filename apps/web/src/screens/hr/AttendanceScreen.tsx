import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { eachDay } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { LogIn, LogOut } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { StatusPill, useP6Error } from '../time/shared';
import { as, body, useHrSettings, type Attendance, type AttendanceReport, type Regularisation } from './api';
import { fmtMinutes, monthOf, monthRange, shiftMonth } from './logic';

type View = 'me' | 'approvals' | 'report';

/** Browser position with a short timeout; null when denied/unavailable (the server then checks the IP only). */
export function getPosition(timeout = 10_000): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { enableHighAccuracy: true, timeout, maximumAge: 60_000 }));
}

export function AttendanceScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  if (!can('hr', 'view')) return <p className="card p-6 text-muted">{t('p6.noAccess')}</p>;
  const view: View = params[0] === 'approvals' || params[0] === 'report' ? params[0] : 'me';
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p6.nav.attendance')}</h1>
      <Tabs<View> label={t('p6.nav.attendance')} value={view} onChange={(v) => go(`attendance/${v}`)}
        tabs={[['me', t('p6.att.mine')], ['approvals', t('p6.att.approvals')], ['report', t('p6.att.report')]]} />
      {view === 'me' && <MyAttendance />}
      {view === 'approvals' && <AttendanceApprovals />}
      {view === 'report' && <MonthlyReport />}
    </div>
  );
}

function MyAttendance() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const me = useMe().data;
  const settings = useHrSettings().data;
  const [month, setMonth] = useState(monthOf(todayIst()));
  const [busy, setBusy] = useState(false);
  const [reg, setReg] = useState<string | null>(null);
  const r = monthRange(month);
  const list = useQuery({ queryKey: ['hr', 'attendance', me?.id, month], enabled: !!me,
    queryFn: () => as<Attendance[]>(api.GET('/hr/attendance', { params: { query: { userId: me!.id, from: r.from, to: r.to } } })) });
  const today = todayIst();
  const todayRow = (list.data ?? []).find((x) => x.date === today);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['hr', 'attendance'] });
  const needsGeo = settings ? ['geofence', 'either', 'both'].includes(settings.attendance.mode) : true;
  const punch = async (kind: 'in' | 'out') => {
    setBusy(true);
    try {
      const pos = needsGeo ? await getPosition() : null;
      if (needsGeo && !pos) toast({ text: t('p6.att.noLocation'), tone: 'error' }, 6000);
      const b = { lat: pos?.lat ?? null, lng: pos?.lng ?? null, deviceAt: new Date().toISOString() };
      if (kind === 'in') {
        const x = await as<{ status: string; flags: string[]; inFence: boolean | null; distanceM: number | null }>(api.POST('/hr/attendance/check-in', { body: b }));
        toast({ text: x.status === 'ok' ? t('p6.att.checkedIn') : t('p6.att.checkedInFlagged', { flags: x.flags.map((f) => t(`p6.flag.${f}` as never)).join(', ') }), tone: x.status === 'ok' ? 'ok' : 'error' }, 6000);
      } else {
        const x = await as<{ minutes: number }>(api.POST('/hr/attendance/check-out', { body: body(b) }));
        toast({ text: t('p6.att.checkedOut', { time: fmtMinutes(x.minutes ?? 0) }), tone: 'ok' }, 5000);
      }
    } catch (e) { toast({ text: err(e), tone: 'error' }); }
    finally { setBusy(false); refresh(); }
  };
  const byDay = new Map((list.data ?? []).map((x) => [x.date, x]));
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center gap-3 p-3">
        {!todayRow ? <button className="btn btn-primary" disabled={busy} onClick={() => void punch('in')}><LogIn size={14} aria-hidden /> {t('p6.att.checkIn')}</button>
          : !todayRow.checkOutAt ? <button className="btn btn-primary" disabled={busy} onClick={() => void punch('out')}><LogOut size={14} aria-hidden /> {t('p6.att.checkOut')}</button>
          : <span>{t('p6.att.doneToday', { time: fmtMinutes(todayRow.minutes ?? 0) })}</span>}
        {todayRow && <span className="text-sm text-muted">{t('p6.att.inAt', { at: formatDateTime(todayRow.checkInAt) })} <StatusPill status={todayRow.status} /></span>}
        <p className="w-full text-xs text-muted">{t('p6.att.privacy')}</p>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn" onClick={() => setMonth(shiftMonth(month, -1))}>{t('p6.prev')}</button>
        <span className="font-medium">{month}</span>
        <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))}>{t('p6.next')}</button>
        <button className="btn ml-auto" onClick={() => setReg(today)}>{t('p6.att.regularise')}</button>
      </div>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.att.mine')}>
        <thead><tr><th>{t('p6.f.date')}</th><th>{t('p6.att.in')}</th><th>{t('p6.att.out')}</th><th className="text-right">{t('p6.f.duration')}</th><th>{t('p6.f.status')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
        <tbody>{[...eachDay(r.from, r.to < today ? r.to : today)].reverse().map((d) => {
          const x = byDay.get(d);
          return (
            <tr key={d}><td>{formatDate(d)}</td><td>{x ? formatDateTime(x.checkInAt).split(', ').pop() : '—'}</td><td>{x?.checkOutAt ? formatDateTime(x.checkOutAt).split(', ').pop() : '—'}</td>
              <td className="text-right tabular-nums">{x?.minutes ? fmtMinutes(x.minutes) : ''}</td>
              <td>{x ? <><StatusPill status={x.status} /> {x.flags.map((f) => <span key={f} className="ml-1 text-xs text-due-soon">{t(`p6.flag.${f}` as never)}</span>)}</> : <span className="text-muted">{t('p6.att.noRecord')}</span>}</td>
              <td className="text-right">{d < today && <button className="btn" onClick={() => setReg(d)}>{t('p6.att.regularise')}</button>}</td></tr>
          );
        })}</tbody>
      </table></div>
      <MyRegularisations />
      {reg && <RegulariseDialog date={reg} onClose={() => setReg(null)} />}
    </div>
  );
}

function MyRegularisations() {
  const t = useT();
  const me = useMe().data;
  const q = useQuery({ queryKey: ['hr', 'regularisations', 'all'], queryFn: () => as<Regularisation[]>(api.GET('/hr/attendance/regularisations')) });
  const mine = (q.data ?? []).filter((x) => x.userId === me?.id);
  if (!mine.length) return null;
  return (
    <section className="space-y-1"><h2 className="font-semibold">{t('p6.att.myRequests')}</h2>
      <ul className="card divide-y divide-border">{mine.map((x) => <li key={x.id} className="flex flex-wrap gap-2 p-2 text-sm"><span>{formatDate(x.date)}</span><span className="text-muted">{x.reason}</span><span className="ml-auto"><StatusPill status={x.status} /></span></li>)}</ul>
    </section>
  );
}

function RegulariseDialog({ date, onClose }: { date: string; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [d, setD] = useState(date);
  const [inT, setIn] = useState('09:30');
  const [outT, setOut] = useState('18:30');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => as<{ id: string }>(api.POST('/hr/attendance/regularisations', { body: { date: d, checkIn: inT, checkOut: outT || null, reason: reason.trim() } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hr'] }); toast({ text: t('p6.requested'), tone: 'ok' }, 3000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p6.att.regularise')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label={t('p6.f.date')}><input type="date" className="input" value={d} max={todayIst()} onChange={(e) => setD(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('p6.att.in')}><input type="time" className="input" value={inT} onChange={(e) => setIn(e.target.value)} required /></Field>
          <Field label={t('p6.att.out')}><input type="time" className="input" value={outT} onChange={(e) => setOut(e.target.value)} /></Field>
        </div>
        <Field label={t('p6.f.reason')}><textarea className="input" value={reason} minLength={3} required onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={reason.trim().length < 3 || m.isPending}>{t('p6.request')}</button></div>
      </form>
    </Dialog>
  );
}

function AttendanceApprovals() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const me = useMe().data;
  const att = useQuery({ queryKey: ['hr', 'attendance', 'pending'], queryFn: () => as<Attendance[]>(api.GET('/hr/attendance', { params: { query: { status: 'needs_approval' } } })) });
  const regs = useQuery({ queryKey: ['hr', 'regularisations', 'pending'], queryFn: () => as<Regularisation[]>(api.GET('/hr/attendance/regularisations', { params: { query: { status: 'pending' } } })) });
  const decide = useMutation({
    mutationFn: ({ kind, id, approve }: { kind: 'att' | 'reg'; id: string; approve: boolean }) => (kind === 'att'
      ? as(api.POST('/hr/attendance/{id}/decide', { params: { path: { id } }, body: { approve } }))
      : as(api.POST('/hr/attendance/regularisations/{id}/decide', { params: { path: { id } }, body: { approve } }))),
    onError: (e) => toast({ text: err(e), tone: 'error' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['hr'] }),
  });
  const Buttons = ({ kind, id, own }: { kind: 'att' | 'reg'; id: string; own: boolean }) => own ? <span className="text-xs text-muted">{t('p6.selfNotApprovable')}</span> : (
    <span className="space-x-1"><button className="btn btn-primary" onClick={() => decide.mutate({ kind, id, approve: true })}>{t('p6.approve')}</button>
      <button className="btn btn-danger" onClick={() => decide.mutate({ kind, id, approve: false })}>{t('p6.reject')}</button></span>);
  return (
    <div className="space-y-4">
      <section><h2 className="mb-1 font-semibold">{t('p6.att.exceptions')}</h2>
        {!(att.data ?? []).length ? <p className="text-muted">{t('p6.nothingPending')}</p> : <div className="card overflow-auto"><table className="table w-full">
          <thead><tr><th>{t('p6.f.person')}</th><th>{t('p6.f.date')}</th><th>{t('p6.att.in')}</th><th>{t('p6.att.flags')}</th><th /></tr></thead>
          <tbody>{(att.data ?? []).map((x) => <tr key={x.id}><td>{x.userName}</td><td>{formatDate(x.date)}</td><td>{formatDateTime(x.checkInAt)}</td>
            <td>{x.flags.map((f) => t(`p6.flag.${f}` as never)).join(', ')}{x.distanceM !== null && <span className="block text-xs text-muted">{t('p6.att.distance', { m: x.distanceM })}</span>}</td>
            <td className="text-right"><Buttons kind="att" id={x.id} own={x.userId === me?.id} /></td></tr>)}</tbody></table></div>}
      </section>
      <section><h2 className="mb-1 font-semibold">{t('p6.att.regularisations')}</h2>
        {!(regs.data ?? []).length ? <p className="text-muted">{t('p6.nothingPending')}</p> : <div className="card overflow-auto"><table className="table w-full">
          <thead><tr><th>{t('p6.f.person')}</th><th>{t('p6.f.date')}</th><th>{t('p6.att.in')}</th><th>{t('p6.att.out')}</th><th>{t('p6.f.reason')}</th><th /></tr></thead>
          <tbody>{(regs.data ?? []).map((x) => <tr key={x.id}><td>{x.userName}</td><td>{formatDate(x.date)}</td><td>{formatDateTime(x.checkInAt)}</td><td>{x.checkOutAt ? formatDateTime(x.checkOutAt) : '—'}</td>
            <td>{x.reason}</td><td className="text-right"><Buttons kind="reg" id={x.id} own={x.userId === me?.id} /></td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}

function MonthlyReport() {
  const t = useT();
  const [month, setMonth] = useState(monthOf(todayIst()));
  const q = useQuery({ queryKey: ['hr', 'attendance-report', month], queryFn: () => as<AttendanceReport>(api.GET('/hr/attendance/report', { params: { query: { month } } })) });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2"><button className="btn" onClick={() => setMonth(shiftMonth(month, -1))}>{t('p6.prev')}</button><span className="font-medium">{month}</span>
        <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))}>{t('p6.next')}</button></div>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.att.report')}>
        <thead><tr><th>{t('p6.f.person')}</th><th className="text-right">{t('p6.att.working')}</th><th className="text-right">{t('p6.att.present')}</th><th className="text-right">{t('p6.att.leave')}</th>
          <th className="text-right">{t('p6.att.absent')}</th><th className="text-right">{t('p6.att.flagged')}</th><th className="text-right">{t('p6.att.pending')}</th><th className="text-right">{t('p6.f.duration')}</th></tr></thead>
        <tbody>{(q.data?.users ?? []).map((u) => <tr key={u.userId}><td>{u.name}</td><td className="text-right">{u.workingDays}</td><td className="text-right">{u.presentDays}</td><td className="text-right">{u.leaveDays}</td>
          <td className={`text-right ${u.absentDays ? 'text-overdue' : ''}`}>{u.absentDays}</td><td className="text-right">{u.flaggedDays}</td><td className="text-right">{u.pendingApproval}</td><td className="text-right tabular-nums">{fmtMinutes(u.minutes)}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}
