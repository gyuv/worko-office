import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { eachDay } from '@worko/domain';
import { formatDate } from '@worko/i18n';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { PersonSelect } from '../tasks/shared';
import { StatusPill, useP6Error } from '../time/shared';
import { as, body, useHolidays, useHrSettings, useLeaveTypes, type Balances, type LedgerRow, type LeaveRequest } from './api';
import { leavePreview, monthOf, monthRange, shiftMonth } from './logic';

type View = 'mine' | 'approvals' | 'ledger' | 'calendar';

export function LeaveScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  const [applying, setApplying] = useState(false);
  if (!can('hr', 'view')) return <p className="card p-6 text-muted">{t('p6.noAccess')}</p>;
  const view: View = (['approvals', 'ledger', 'calendar'] as const).find((v) => v === params[0]) ?? 'mine';
  return (
    <div className="space-y-3">
      <header className="flex items-center gap-2"><h1 className="text-xl font-semibold">{t('p6.nav.leave')}</h1>
        <button className="btn btn-primary ml-auto" onClick={() => setApplying(true)}><Plus size={14} aria-hidden /> {t('p6.leave.apply')}</button></header>
      <Tabs<View> label={t('p6.nav.leave')} value={view} onChange={(v) => go(`leave/${v}`)}
        tabs={[['mine', t('p6.leave.mine')], ['approvals', t('p6.leave.approvals')], ['ledger', t('p6.leave.ledger')], ['calendar', t('p6.leave.calendar')]]} />
      {view === 'mine' && <MyLeave />}
      {view === 'approvals' && <LeaveApprovals />}
      {view === 'ledger' && <Ledger />}
      {view === 'calendar' && <TeamCalendar />}
      {applying && <ApplyDialog onClose={() => setApplying(false)} />}
    </div>
  );
}

const useRequests = (query: { userId?: string; status?: string; from?: string; to?: string }) =>
  useQuery({ queryKey: ['hr', 'leave', 'requests', query], queryFn: () => as<LeaveRequest[]>(api.GET('/hr/leave/requests', { params: { query } })) });

function MyLeave() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const me = useMe().data;
  const types = useLeaveTypes().data ?? [];
  const bal = useQuery({ queryKey: ['hr', 'leave', 'balances', me?.id], enabled: !!me, queryFn: () => as<Balances>(api.GET('/hr/leave/balances', { params: { query: { userId: me!.id } } })) });
  const reqs = useRequests({ userId: me?.id });
  const cancel = useMutation({
    mutationFn: (id: string) => as(api.POST('/hr/leave/requests/{id}/cancel', { params: { path: { id } } })),
    onError: (e) => toast({ text: err(e), tone: 'error' }), onSettled: () => void qc.invalidateQueries({ queryKey: ['hr', 'leave'] }),
  });
  const today = todayIst();
  const typeName = (id: string) => types.find((x) => x.id === id)?.name ?? '';
  return (
    <div className="space-y-3">
      <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label={t('p6.leave.balances')}>
        {(bal.data?.balances ?? []).map((b) => (
          <li key={b.leaveType.id} className="card p-3">
            <div className="text-sm text-muted">{b.leaveType.name}</div>
            <div className="text-2xl font-semibold tabular-nums" data-testid={`bal-${b.leaveType.key}`}>{b.available}</div>
            <div className="text-xs text-muted">{t('p6.leave.balanceLine', { balance: b.balance, pending: b.pending })}</div>
            {b.expiring.map((x) => <div key={x.expiresOn} className="text-xs text-due-soon">{t('p6.leave.expiring', { days: x.days, date: formatDate(x.expiresOn) })}</div>)}
          </li>
        ))}
      </ul>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.leave.mine')}>
        <thead><tr><th>{t('p6.leave.type')}</th><th>{t('p6.f.from')}</th><th>{t('p6.f.to')}</th><th className="text-right">{t('p6.leave.days')}</th><th>{t('p6.f.status')}</th><th /></tr></thead>
        <tbody>{(reqs.data ?? []).map((r) => (
          <tr key={r.id}><td>{typeName(r.leaveTypeId)}</td><td>{formatDate(r.from)}{r.startHalf ? ` ${t('p6.leave.halfMark')}` : ''}</td><td>{formatDate(r.to)}{r.endHalf ? ` ${t('p6.leave.halfMark')}` : ''}</td>
            <td className="text-right">{r.days}{r.approvedDays !== null && r.approvedDays !== r.days && <span className="block text-xs text-muted">{t('p6.leave.approvedDays', { days: r.approvedDays })}</span>}</td>
            <td><StatusPill status={r.status} />{r.decisionNote && <span className="block text-xs text-muted">{r.decisionNote}</span>}</td>
            <td className="text-right">{(r.status === 'pending' || ((r.status === 'approved' || r.status === 'partially_approved') && (r.approvedFrom ?? r.from) > today)) &&
              <button className="btn" onClick={() => cancel.mutate(r.id)}>{t('p6.leave.cancel')}</button>}</td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function ApplyDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const types = (useLeaveTypes().data ?? []).filter((x) => x.active);
  const settings = useHrSettings().data;
  const [typeId, setTypeId] = useState('');
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [startHalf, setSH] = useState(false);
  const [endHalf, setEH] = useState(false);
  const [reason, setReason] = useState('');
  const holidays = useHolidays(from, to >= from ? to : from).data ?? [];
  const type = types.find((x) => x.id === (typeId || types[0]?.id));
  const preview = settings ? leavePreview({ from, to, startHalf, endHalf }, settings.workWeek, holidays) : null;
  const tooMany = !!(preview && type?.maxDaysPerRequest && preview.days > type.maxDaysPerRequest);
  const m = useMutation({
    mutationFn: () => as<{ id: string; days: number }>(api.POST('/hr/leave/requests', { body: { leaveTypeId: type!.id, from, to, startHalf, endHalf, reason: reason.trim() || null } })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['hr', 'leave'] }); toast({ text: t('p6.leave.applied', { days: r.days }), tone: 'ok' }, 4000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p6.leave.apply')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (type && preview && preview.days > 0) m.mutate(); }}>
        <Field label={t('p6.leave.type')}><select className="input" value={type?.id ?? ''} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('p6.f.from')}><input type="date" className="input" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} required /></Field>
          <Field label={t('p6.f.to')}><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></Field>
        </div>
        {type?.allowHalfDay !== false && <div className="flex gap-4">
          <label className="flex items-center gap-2"><input type="checkbox" checked={startHalf} onChange={(e) => setSH(e.target.checked)} /> {t('p6.leave.startHalf')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={endHalf} onChange={(e) => setEH(e.target.checked)} /> {t('p6.leave.endHalf')}</label>
        </div>}
        <Field label={t('p6.f.reason')}><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div role="status" className="rounded bg-surface-alt p-2 text-sm" data-testid="leave-preview">
          {preview ? <>{t('p6.leave.preview', { days: preview.days })}
            {preview.skipped.length > 0 && <span className="block text-xs text-muted">{t('p6.leave.skipped')}: {preview.skipped.map((s) => `${formatDate(s.date)} (${s.why === 'holiday' ? s.name : t('p6.leave.weekend')})`).join(', ')}</span>}
          </> : t('p6.leave.badRange')}
          {tooMany && <span className="block text-overdue">{t('p6.leave.tooMany', { max: type!.maxDaysPerRequest! })}</span>}
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!type || !preview || preview.days <= 0 || tooMany || m.isPending}>{t('p6.leave.submit')}</button></div>
      </form>
    </Dialog>
  );
}

function LeaveApprovals() {
  const t = useT();
  const me = useMe().data;
  const types = useLeaveTypes().data ?? [];
  const reqs = useRequests({ status: 'pending' });
  const [deciding, setDeciding] = useState<LeaveRequest | null>(null);
  const items = reqs.data ?? [];
  return (
    <div className="space-y-2">
      {reqs.data && !items.length && <p className="card p-6 text-muted">{t('p6.nothingPending')}</p>}
      {!!items.length && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.leave.approvals')}>
        <thead><tr><th>{t('p6.f.person')}</th><th>{t('p6.leave.type')}</th><th>{t('p6.f.from')}</th><th>{t('p6.f.to')}</th><th className="text-right">{t('p6.leave.days')}</th><th>{t('p6.f.reason')}</th><th /></tr></thead>
        <tbody>{items.map((r) => (
          <tr key={r.id}><td>{r.userName}</td><td>{types.find((x) => x.id === r.leaveTypeId)?.name}</td><td>{formatDate(r.from)}</td><td>{formatDate(r.to)}</td><td className="text-right">{r.days}</td><td>{r.reason}</td>
            <td className="text-right">{r.userId === me?.id ? <span className="text-xs text-muted">{t('p6.selfNotApprovable')}</span> : <button className="btn" onClick={() => setDeciding(r)}>{t('p6.decide')}</button>}</td></tr>
        ))}</tbody>
      </table></div>}
      {deciding && <DecideLeave r={deciding} onClose={() => setDeciding(null)} />}
    </div>
  );
}

function DecideLeave({ r, onClose }: { r: LeaveRequest; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const settings = useHrSettings().data;
  const holidays = useHolidays(r.from, r.to).data ?? [];
  const [mode, setMode] = useState<'full' | 'partial' | 'reject'>('full');
  const [af, setAf] = useState(r.from);
  const [at, setAt] = useState(r.to);
  const [note, setNote] = useState('');
  const sh = mode === 'partial' ? af === r.from && r.startHalf : r.startHalf;
  const eh = mode === 'partial' ? at === r.to && r.endHalf : r.endHalf;
  const preview = settings && mode !== 'reject' ? leavePreview({ from: mode === 'partial' ? af : r.from, to: mode === 'partial' ? at : r.to, startHalf: sh, endHalf: eh }, settings.workWeek, holidays) : null;
  const badRange = mode === 'partial' && (af < r.from || at > r.to || af > at);
  const m = useMutation({
    mutationFn: () => as<{ status: string; approvedDays: number }>(api.POST('/hr/leave/requests/{id}/decide', { params: { path: { id: r.id } },
      body: body(mode === 'reject' ? { approve: false, note: note.trim() || null } : mode === 'partial' ? { approve: true, approvedFrom: af, approvedTo: at, startHalf: sh, endHalf: eh, note: note.trim() || null } : { approve: true, note: note.trim() || null }) })),
    onSuccess: (x) => { void qc.invalidateQueries({ queryKey: ['hr', 'leave'] }); toast({ text: t('p6.leave.decided', { status: t(`p6.status.${x.status}` as never), days: x.approvedDays }), tone: 'ok' }, 4000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p6.leave.decideTitle', { who: r.userName ?? '' })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!badRange) m.mutate(); }}>
        <p className="text-sm">{formatDate(r.from)} – {formatDate(r.to)} · {t('p6.leave.preview', { days: r.days })}</p>
        <fieldset className="space-y-1"><legend className="label">{t('p6.decision')}</legend>
          {(['full', 'partial', 'reject'] as const).map((k) => <label key={k} className="flex items-center gap-2"><input type="radio" name="mode" checked={mode === k} onChange={() => setMode(k)} /> {t(`p6.leave.mode.${k}`)}</label>)}
        </fieldset>
        {mode === 'partial' && <div className="grid grid-cols-2 gap-3">
          <Field label={t('p6.leave.approvedFrom')}><input type="date" className="input" min={r.from} max={r.to} value={af} onChange={(e) => setAf(e.target.value)} /></Field>
          <Field label={t('p6.leave.approvedTo')}><input type="date" className="input" min={r.from} max={r.to} value={at} onChange={(e) => setAt(e.target.value)} /></Field>
        </div>}
        {preview && <p role="status" className="rounded bg-surface-alt p-2 text-sm">{t('p6.leave.willApprove', { days: preview.days })}</p>}
        {badRange && <p role="alert" className="text-sm text-overdue">{t('p6.leave.badRange')}</p>}
        <Field label={t('p6.f.note')}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className={`btn ${mode === 'reject' ? 'btn-danger' : 'btn-primary'}`} disabled={badRange || m.isPending}>{t('p6.confirm')}</button></div>
      </form>
    </Dialog>
  );
}

function Ledger() {
  const t = useT();
  const me = useMe().data;
  const types = useLeaveTypes().data ?? [];
  const [userId, setUserId] = useState<string | null>(null);
  const uid = userId ?? me?.id;
  const q = useQuery({ queryKey: ['hr', 'leave', 'ledger', uid], enabled: !!uid, queryFn: () => as<LedgerRow[]>(api.GET('/hr/leave/ledger', { params: { query: { userId: uid } } })) });
  return (
    <div className="space-y-2">
      <div className="max-w-xs"><PersonSelect label={t('p6.f.person')} value={uid ?? null} onChange={setUserId} allowNone={false} /></div>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.leave.ledger')}>
        <thead><tr><th>{t('p6.f.date')}</th><th>{t('p6.leave.type')}</th><th>{t('p6.leave.reason')}</th><th className="text-right">{t('p6.leave.delta')}</th><th>{t('p6.leave.expires')}</th><th>{t('p6.f.note')}</th></tr></thead>
        <tbody>{(q.data ?? []).map((x) => <tr key={x.id}><td>{formatDate(x.on)}</td><td>{types.find((y) => y.id === x.leaveTypeId)?.name ?? x.leaveTypeKey}</td><td>{t(`p6.ledger.${x.reason}` as never)}</td>
          <td className={`text-right tabular-nums ${x.delta < 0 ? 'text-overdue' : 'text-done'}`}>{x.delta > 0 ? `+${x.delta}` : x.delta}</td><td>{x.expiresOn ? formatDate(x.expiresOn) : ''}</td><td>{x.note}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

function TeamCalendar() {
  const t = useT();
  const [month, setMonth] = useState(monthOf(todayIst()));
  const r = monthRange(month);
  const reqs = useRequests({ from: r.from, to: r.to });
  const holidays = useHolidays(r.from, r.to).data ?? [];
  const days = [...eachDay(r.from, r.to)];
  const live = (reqs.data ?? []).filter((x) => ['pending', 'approved', 'partially_approved'].includes(x.status));
  const people = [...new Map(live.map((x) => [x.userId, x.userName ?? ''])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const on = (uid: string, d: string) => live.find((x) => x.userId === uid && (x.status === 'pending' ? x.from <= d && d <= x.to : (x.approvedFrom ?? x.from) <= d && d <= (x.approvedTo ?? x.to)));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2"><button className="btn" onClick={() => setMonth(shiftMonth(month, -1))}>{t('p6.prev')}</button><span className="font-medium">{month}</span>
        <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))}>{t('p6.next')}</button>
        <span className="ml-auto text-xs text-muted">■ {t('p6.status.approved')} · ▨ {t('p6.status.pending')}</span></div>
      {!people.length ? <p className="card p-6 text-muted">{t('p6.leave.nobodyOff')}</p> : <div className="card overflow-auto"><table className="table text-xs" aria-label={t('p6.leave.calendar')}>
        <thead><tr><th>{t('p6.f.person')}</th>{days.map((d) => <th key={d} className={`px-1 text-center ${holidays.some((h) => h.date === d) ? 'text-due-soon' : ''}`} title={holidays.find((h) => h.date === d)?.name}>{d.slice(8)}</th>)}</tr></thead>
        <tbody>{people.map(([uid, name]) => <tr key={uid}><td className="whitespace-nowrap">{name}</td>{days.map((d) => {
          const x = on(uid, d);
          return <td key={d} className="px-1 text-center" title={x ? t(`p6.status.${x.status}` as never) : undefined}
            style={x ? { background: x.status === 'pending' ? 'color-mix(in srgb, var(--w-status-waiting-client) 25%, transparent)' : 'color-mix(in srgb, var(--w-status-done) 45%, transparent)' } : undefined}>{x ? (x.status === 'pending' ? '▨' : '■') : ''}</td>;
        })}</tr>)}</tbody>
      </table></div>}
    </div>
  );
}
