import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isValidCidr } from '@worko/domain';
import { formatDate } from '@worko/i18n';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { errStatus, todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api } from '../../lib/session';
import { paiseToInput, parseRupees } from '../billing/logic';
import { Money, RupeeInput } from '../billing/shared';
import { useUsers } from '../tasks/shared';
import { useP6Error } from '../time/shared';
import { as, body, useCategories, useHolidays, useHrSettings, useLeaveTypes, type Capacity, type CostRate, type HrSettings as Settings, type LeaveType, type OfficeLocation } from './api';
import { fmtMinutes } from './logic';

type Sub = 'general' | 'holidays' | 'locations' | 'leave' | 'categories' | 'capacity' | 'costs';
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Settings → HR. Firm config needs firm-wide hr:edit (server re-checks); cost rates need settings:view (D87). */
export function HrSettings() {
  const t = useT();
  const can = useCan();
  const [sub, setSub] = useState<Sub>('general');
  const tabs: Array<[Sub, string]> = [['general', t('p6.hs.general')], ['holidays', t('p6.hs.holidays')], ['locations', t('p6.hs.locations')], ['leave', t('p6.hs.leaveTypes')],
    ['categories', t('p6.hs.categories')], ['capacity', t('p6.hs.capacity')], ...(can('settings', 'view') ? [['costs', t('p6.hs.costs')] as [Sub, string]] : [])];
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p6.hs.title')}</h1>
      <Tabs<Sub> label={t('p6.hs.title')} tabs={tabs} value={sub} onChange={setSub} />
      {sub === 'general' && <General />}
      {sub === 'holidays' && <Holidays />}
      {sub === 'locations' && <Locations />}
      {sub === 'leave' && <LeaveTypes />}
      {sub === 'categories' && <Categories />}
      {sub === 'capacity' && <CapacitySettings />}
      {sub === 'costs' && <CostRates />}
    </div>
  );
}

const useEditable = () => useCan()('hr', 'edit');

function General() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const editable = useEditable();
  const s = useHrSettings().data;
  const [d, setD] = useState<Settings | null>(null);
  const [cidrs, setCidrs] = useState('');
  useEffect(() => { if (s) { setD(s); setCidrs(s.attendance.ipAllowList.join('\n')); } }, [s]);
  const list = cidrs.split(/[\s,]+/).filter(Boolean);
  const badCidr = list.find((c) => !isValidCidr(c));
  const save = useMutation({
    mutationFn: () => as<Settings>(api.PUT('/hr/settings', { body: body({ ...d!, attendance: { ...d!.attendance, ipAllowList: list } }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hr', 'settings'] }); toast({ text: t('p6.saved'), tone: 'ok' }, 2500); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  if (!d) return <p className="text-muted">{t('common.loading')}</p>;
  const up = (p: Partial<Settings>) => setD({ ...d, ...p });
  return (
    <form className="card max-w-2xl space-y-3 p-3" onSubmit={(e) => { e.preventDefault(); if (!badCidr) save.mutate(); }}>
      <fieldset disabled={!editable} className="space-y-3">
        <h2 className="font-semibold">{t('p6.nav.attendance')}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('p6.hs.mode')}><select className="input" value={d.attendance.mode} onChange={(e) => up({ attendance: { ...d.attendance, mode: e.target.value as Settings['attendance']['mode'] } })}>
            {(['none', 'geofence', 'ip', 'either', 'both'] as const).map((m) => <option key={m} value={m}>{t(`p6.hs.mode.${m}`)}</option>)}</select></Field>
          <Field label={t('p6.hs.outside')}><select className="input" value={d.attendance.outside} onChange={(e) => up({ attendance: { ...d.attendance, outside: e.target.value as 'flag' | 'approval' } })}>
            <option value="flag">{t('p6.hs.outside.flag')}</option><option value="approval">{t('p6.hs.outside.approval')}</option></select></Field>
        </div>
        <Field label={t('p6.hs.cidrs')} error={badCidr ? t('p6.hs.badCidr', { cidr: badCidr }) : null} hint={t('p6.hs.cidrsHint')}>
          <textarea className="input font-mono" value={cidrs} onChange={(e) => setCidrs(e.target.value)} /></Field>
        <Field label={t('p6.hs.skew')}><input type="number" min={1} max={1440} className="input" value={d.attendance.skewFlagMinutes} onChange={(e) => up({ attendance: { ...d.attendance, skewFlagMinutes: Number(e.target.value) } })} /></Field>
        <h2 className="font-semibold">{t('p6.hs.workWeek')}</h2>
        <fieldset className="flex flex-wrap gap-3"><legend className="label">{t('p6.hs.weekend')}</legend>
          {WEEKDAYS.map((w) => <label key={w} className="flex items-center gap-1"><input type="checkbox" checked={d.workWeek.weekendDays.includes(w)}
            onChange={(e) => up({ workWeek: { ...d.workWeek, weekendDays: e.target.checked ? [...d.workWeek.weekendDays, w].sort() : d.workWeek.weekendDays.filter((x) => x !== w) } })} /> {t(`p6.dow.${w}`)}</label>)}
        </fieldset>
        <label className="flex items-center gap-2"><input type="checkbox" checked={d.workWeek.excludeWeekends} onChange={(e) => up({ workWeek: { ...d.workWeek, excludeWeekends: e.target.checked } })} /> {t('p6.hs.excludeWeekends')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={d.workWeek.excludeHolidays} onChange={(e) => up({ workWeek: { ...d.workWeek, excludeHolidays: e.target.checked } })} /> {t('p6.hs.excludeHolidays')}</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('p6.hs.defaultCapacity')} hint={fmtMinutes(d.capacity.defaultWeeklyMinutes)}><input type="number" min={0} max={10080} className="input" value={d.capacity.defaultWeeklyMinutes} onChange={(e) => up({ capacity: { defaultWeeklyMinutes: Number(e.target.value) } })} /></Field>
          <Field label={t('p6.hs.timerCap')} hint={fmtMinutes(d.timer.capMinutes)}><input type="number" min={15} max={1440} className="input" value={d.timer.capMinutes} onChange={(e) => up({ timer: { capMinutes: Number(e.target.value) } })} /></Field>
        </div>
        <h2 className="font-semibold">{t('p6.hs.compOff')}</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={d.compOff.enabled} onChange={(e) => up({ compOff: { ...d.compOff, enabled: e.target.checked } })} /> {t('p6.hs.compOffEnabled')}</label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('p6.hs.halfDayMin')}><input type="number" className="input" value={d.compOff.halfDayMinutes} onChange={(e) => up({ compOff: { ...d.compOff, halfDayMinutes: Number(e.target.value) } })} /></Field>
          <Field label={t('p6.hs.fullDayMin')}><input type="number" className="input" value={d.compOff.fullDayMinutes} onChange={(e) => up({ compOff: { ...d.compOff, fullDayMinutes: Number(e.target.value) } })} /></Field>
          <Field label={t('p6.hs.expiryDays')}><input type="number" className="input" value={d.compOff.expiryDays} onChange={(e) => up({ compOff: { ...d.compOff, expiryDays: Number(e.target.value) } })} /></Field>
        </div>
        {editable && <button className="btn btn-primary" disabled={!!badCidr || save.isPending}>{t('common.save')}</button>}
      </fieldset>
    </form>
  );
}

function Holidays() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const editable = useEditable();
  const year = todayIst().slice(0, 4);
  const list = useHolidays(`${year}-01-01`, `${Number(year) + 1}-12-31`);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [optional, setOptional] = useState(false);
  const inv = () => void qc.invalidateQueries({ queryKey: ['hr', 'holidays'] });
  const add = useMutation({ mutationFn: () => as(api.POST('/hr/holidays', { body: { date, name: name.trim(), optional } })), onSuccess: () => { setDate(''); setName(''); inv(); }, onError: (e) => toast({ text: err(e), tone: 'error' }) });
  const del = useMutation({ mutationFn: (id: string) => as(api.DELETE('/hr/holidays/{id}', { params: { path: { id } } })), onSuccess: inv, onError: (e) => toast({ text: err(e), tone: 'error' }) });
  return (
    <div className="space-y-2">
      {editable && <form className="card flex flex-wrap items-end gap-2 p-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Field label={t('p6.f.date')}><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label={t('p6.hs.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={optional} onChange={(e) => setOptional(e.target.checked)} /> {t('p6.hs.optional')}</label>
        <button className="btn btn-primary" disabled={!date || !name.trim()}><Plus size={14} aria-hidden /> {t('p6.add')}</button>
      </form>}
      <div className="card overflow-auto"><table className="table w-full"><thead><tr><th>{t('p6.f.date')}</th><th>{t('p6.hs.name')}</th><th>{t('p6.hs.optional')}</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((h) => <tr key={h.id}><td>{formatDate(h.date)}</td><td>{h.name}{h.branchId && <span className="ml-1 text-xs text-muted">{t('p6.hs.branchOnly')}</span>}</td><td>{h.optional ? t('svc.yes') : ''}</td>
          <td className="text-right">{editable && <button className="btn" aria-label={t('p6.hs.deleteNamed', { name: h.name })} onClick={() => del.mutate(h.id)}><Trash2 size={14} /></button>}</td></tr>)}</tbody></table></div>
    </div>
  );
}

function Locations() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const editable = useEditable();
  const list = useQuery({ queryKey: ['hr', 'locations'], queryFn: () => as<OfficeLocation[]>(api.GET('/hr/office-locations')) });
  const [editing, setEditing] = useState<OfficeLocation | 'new' | null>(null);
  const patch = useMutation({ mutationFn: ({ id, b }: { id: string; b: Record<string, unknown> }) => as(api.PATCH('/hr/office-locations/{id}', { params: { path: { id } }, body: body(b) })),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['hr', 'locations'] }), onError: (e) => toast({ text: err(e), tone: 'error' }) });
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{t('p6.hs.locationsHint')}</p>
      {editable && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('p6.hs.addLocation')}</button>}
      <div className="card overflow-auto"><table className="table w-full"><thead><tr><th>{t('p6.hs.name')}</th><th>{t('p6.hs.lat')}</th><th>{t('p6.hs.lng')}</th><th>{t('p6.hs.radius')}</th><th>{t('bs.active')}</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((l) => <tr key={l.id} className={l.active ? '' : 'text-muted'}><td>{l.name}</td><td className="tabular-nums">{l.lat}</td><td className="tabular-nums">{l.lng}</td><td>{l.radiusM} m</td>
          <td><input type="checkbox" aria-label={t('p6.hs.activeNamed', { name: l.name })} disabled={!editable} checked={l.active} onChange={(e) => patch.mutate({ id: l.id, b: { active: e.target.checked } })} /></td>
          <td className="space-x-1 text-right">{editable && <><button className="btn" onClick={() => setEditing(l)}>{t('p6.edit')}</button>
            <button className="btn" aria-label={t('p6.hs.deleteNamed', { name: l.name })} onClick={() => patch.mutate({ id: l.id, b: { deleted: true } })}><Trash2 size={14} /></button></>}</td></tr>)}</tbody></table></div>
      {editing && <LocationDialog l={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LocationDialog({ l, onClose }: { l: OfficeLocation | null; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [name, setName] = useState(l?.name ?? '');
  const [lat, setLat] = useState(l ? String(l.lat) : '');
  const [lng, setLng] = useState(l ? String(l.lng) : '');
  const [radius, setRadius] = useState(String(l?.radiusM ?? 150));
  const b = { name: name.trim(), lat: Number(lat), lng: Number(lng), radiusM: Number(radius) };
  const bad = !b.name || !lat || !lng || !(Math.abs(b.lat) <= 90) || !(Math.abs(b.lng) <= 180) || !(b.radiusM >= 10 && b.radiusM <= 5000);
  const m = useMutation({
    mutationFn: () => (l ? as(api.PATCH('/hr/office-locations/{id}', { params: { path: { id: l.id } }, body: body(b) })) : as(api.POST('/hr/office-locations', { body: b }))),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hr', 'locations'] }); onClose(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={l ? l.name : t('p6.hs.addLocation')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!bad) m.mutate(); }}>
        <Field label={t('p6.hs.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('p6.hs.lat')}><input className="input" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} /></Field>
          <Field label={t('p6.hs.lng')}><input className="input" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} /></Field>
          <Field label={t('p6.hs.radius')}><input type="number" min={10} max={5000} className="input" value={radius} onChange={(e) => setRadius(e.target.value)} /></Field>
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={bad || m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

function LeaveTypes() {
  const t = useT();
  const editable = useEditable();
  const list = useLeaveTypes();
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null);
  return (
    <div className="space-y-2">
      {editable && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('p6.hs.addLeaveType')}</button>}
      <div className="card overflow-auto"><table className="table w-full"><thead><tr><th>{t('p6.hs.key')}</th><th>{t('p6.hs.name')}</th><th>{t('p6.hs.paid')}</th><th>{t('p6.hs.accrual')}</th><th>{t('p6.hs.cfCap')}</th><th>{t('p6.hs.halfDay')}</th><th>{t('bs.active')}</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((x) => <tr key={x.id} className={x.active ? '' : 'text-muted'}><td className="font-mono text-xs">{x.key}</td><td>{x.name}</td><td>{x.paid ? t('svc.yes') : t('svc.no')}</td>
          <td>{x.accrual.kind === 'none' ? '—' : t(`p6.hs.accrual.${x.accrual.kind}`, { days: x.accrual.days })}</td><td>{x.carryForwardCap ?? '—'}</td><td>{x.allowHalfDay ? t('svc.yes') : t('svc.no')}</td><td>{x.active ? t('svc.yes') : t('svc.no')}</td>
          <td className="text-right">{editable && <button className="btn" onClick={() => setEditing(x)}>{t('p6.edit')}</button>}</td></tr>)}</tbody></table></div>
      {editing && <LeaveTypeDialog x={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LeaveTypeDialog({ x, onClose }: { x: LeaveType | null; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [key, setKey] = useState(x?.key ?? '');
  const [name, setName] = useState(x?.name ?? '');
  const [paid, setPaid] = useState(x?.paid ?? true);
  const [kind, setKind] = useState(x?.accrual.kind ?? 'none');
  const [days, setDays] = useState(String(x?.accrual.days ?? 0));
  const [cap, setCap] = useState(x?.carryForwardCap === null || x?.carryForwardCap === undefined ? '' : String(x.carryForwardCap));
  const [half, setHalf] = useState(x?.allowHalfDay ?? true);
  const [max, setMax] = useState(x?.maxDaysPerRequest ? String(x.maxDaysPerRequest) : '');
  const [active, setActive] = useState(x?.active ?? true);
  const b = { name: name.trim(), paid, accrual: { kind, days: Number(days) || 0 }, carryForwardCap: cap === '' ? null : Number(cap), allowHalfDay: half, maxDaysPerRequest: max === '' ? null : Number(max), active };
  const m = useMutation({
    mutationFn: () => (x ? as(api.PATCH('/hr/leave-types/{id}', { params: { path: { id: x.id } }, body: body(b) })) : as(api.POST('/hr/leave-types', { body: body({ key, ...b }) }))),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hr', 'leave-types'] }); onClose(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={x ? x.name : t('p6.hs.addLeaveType')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('p6.hs.key')}><input className="input font-mono" value={key} disabled={!!x} pattern="[a-z0-9_]{2,40}" onChange={(e) => setKey(e.target.value)} required /></Field>
          <Field label={t('p6.hs.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label={t('p6.hs.accrual')}><select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="none">—</option><option value="monthly">{t('p6.hs.monthly')}</option><option value="annual">{t('p6.hs.annual')}</option></select></Field>
          <Field label={t('p6.hs.accrualDays')}><input type="number" step={0.5} min={0} className="input" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <Field label={t('p6.hs.cfCap')}><input type="number" step={0.5} min={0} className="input" value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
          <Field label={t('p6.hs.maxDays')}><input type="number" step={0.5} min={0.5} className="input" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> {t('p6.hs.paid')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} /> {t('p6.hs.halfDay')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('bs.active')}</label>
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

function Categories() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const editable = useEditable();
  const list = useCategories();
  const [draft, setDraft] = useState({ key: '', name: '', limit: '', limitMode: 'warn' as 'warn' | 'block' });
  const save = useMutation({
    mutationFn: (b: { key: string; name: string; limitPaise: number | null; limitMode: 'warn' | 'block'; active: boolean }) => as(api.PUT('/hr/expense-categories', { body: b })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hr', 'categories'] }); setDraft({ key: '', name: '', limit: '', limitMode: 'warn' }); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const lim = draft.limit === '' ? null : parseRupees(draft.limit);
  return (
    <div className="space-y-2">
      <div className="card overflow-auto"><table className="table w-full"><thead><tr><th>{t('p6.hs.key')}</th><th>{t('p6.hs.name')}</th><th className="text-right">{t('p6.hs.limit')}</th><th>{t('p6.hs.limitMode')}</th><th>{t('bs.active')}</th></tr></thead>
        <tbody>{(list.data ?? []).map((c) => <tr key={c.id} className={c.active ? '' : 'text-muted'}><td className="font-mono text-xs">{c.key}</td><td>{c.name}</td><td className="text-right"><Money p={c.limitPaise} /></td><td>{t(`p6.hs.limitMode.${c.limitMode}`)}</td>
          <td><input type="checkbox" aria-label={t('p6.hs.activeNamed', { name: c.name })} disabled={!editable} checked={c.active} onChange={(e) => save.mutate({ key: c.key, name: c.name, limitPaise: c.limitPaise, limitMode: c.limitMode, active: e.target.checked })} /></td></tr>)}</tbody></table></div>
      {editable && <form className="card flex flex-wrap items-end gap-2 p-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ key: draft.key, name: draft.name.trim(), limitPaise: lim, limitMode: draft.limitMode, active: true }); }}>
        <Field label={t('p6.hs.key')} hint={t('p6.hs.keyHint')}><input className="input font-mono" pattern="[a-z0-9_]{2,40}" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} required /></Field>
        <Field label={t('p6.hs.name')}><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required /></Field>
        <Field label={t('p6.hs.limit')}><RupeeInput label={t('p6.hs.limit')} value={draft.limit} onChange={(v) => setDraft({ ...draft, limit: v })} /></Field>
        <Field label={t('p6.hs.limitMode')}><select className="input" value={draft.limitMode} onChange={(e) => setDraft({ ...draft, limitMode: e.target.value as 'warn' | 'block' })}>
          <option value="warn">{t('p6.hs.limitMode.warn')}</option><option value="block">{t('p6.hs.limitMode.block')}</option></select></Field>
        <button className="btn btn-primary" disabled={draft.limit !== '' && lim === null}>{t('common.save')}</button>
      </form>}
    </div>
  );
}

function CapacitySettings() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const editable = useEditable();
  const cap = useQuery({ queryKey: ['reports', 'capacity', 'settings'], queryFn: () => as<Capacity>(api.GET('/reports/capacity', { params: { query: { weeks: 1 } } })) });
  const save = useMutation({
    mutationFn: ({ userId, weeklyMinutes }: { userId: string; weeklyMinutes: number }) => as(api.PUT('/hr/capacity/{userId}', { params: { path: { userId } }, body: { weeklyMinutes } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['reports'] }); toast({ text: t('p6.saved'), tone: 'ok' }, 2000); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <div className="card overflow-auto"><table className="table w-full"><thead><tr><th>{t('p6.f.person')}</th><th>{t('p6.hs.weeklyHours')}</th></tr></thead>
      <tbody>{(cap.data?.users ?? []).map((u) => <tr key={u.userId}><td>{u.name}</td><td>
        <input type="number" step={0.5} min={0} max={168} className="input w-24 text-right" aria-label={t('p6.hs.capacityOf', { name: u.name })} disabled={!editable}
          defaultValue={u.weeklyCapacityMinutes / 60} key={u.weeklyCapacityMinutes}
          onBlur={(e) => { const mins = Math.round(Number(e.target.value) * 60); if (e.target.value !== '' && Number.isFinite(mins) && mins !== u.weeklyCapacityMinutes && mins >= 0 && mins <= 10080) save.mutate({ userId: u.userId, weeklyMinutes: mins }); }} /></td></tr>)}</tbody></table>
      <p className="p-2 text-xs text-muted">{t('p6.hs.capacityHint')}</p></div>
  );
}

function CostRates() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const can = useCan();
  const { users } = useUsers();
  const list = useQuery({ queryKey: ['hr', 'cost-rates'], retry: false, queryFn: () => as<CostRate[]>(api.GET('/hr/cost-rates')) });
  const [userId, setUserId] = useState('');
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState(todayIst());
  const p = parseRupees(rate);
  const inv = () => void qc.invalidateQueries({ queryKey: ['hr', 'cost-rates'] });
  const add = useMutation({ mutationFn: () => as(api.POST('/hr/cost-rates', { body: { userId, hourlyPaise: p!, effectiveFrom: from } })), onSuccess: () => { setRate(''); inv(); }, onError: (e) => toast({ text: err(e), tone: 'error' }) });
  const del = useMutation({ mutationFn: (id: string) => as(api.DELETE('/hr/cost-rates/{id}', { params: { path: { id } } })), onSuccess: inv, onError: (e) => toast({ text: err(e), tone: 'error' }) });
  if (list.isError) return <p className="card p-6 text-muted">{errStatus(list.error) === 403 ? t('p6.hs.costsHidden') : t('common.error')}</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{t('p6.hs.costsHint')}</p>
      {can('settings', 'edit') && <form className="card flex flex-wrap items-end gap-2 p-3" onSubmit={(e) => { e.preventDefault(); if (userId && p !== null) add.mutate(); }}>
        <Field label={t('p6.f.person')}><select className="input" value={userId} onChange={(e) => setUserId(e.target.value)} required><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label={t('p6.hs.hourly')}><RupeeInput label={t('p6.hs.hourly')} value={rate} onChange={setRate} /></Field>
        <Field label={t('p6.hs.effectiveFrom')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
        <button className="btn btn-primary" disabled={!userId || p === null || add.isPending}>{t('p6.add')}</button>
      </form>}
      <div className="card overflow-auto"><table className="table w-full"><thead><tr><th>{t('p6.f.person')}</th><th className="text-right">{t('p6.hs.hourly')}</th><th>{t('p6.hs.effectiveFrom')}</th><th>{t('p6.hs.effectiveTo')}</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((r) => <tr key={r.id}><td>{r.userName}</td><td className="text-right"><Money p={r.hourlyPaise} /></td><td>{formatDate(r.effectiveFrom)}</td><td>{r.effectiveTo ? formatDate(r.effectiveTo) : '—'}</td>
          <td className="text-right">{can('settings', 'edit') && <button className="btn" aria-label={t('p6.hs.deleteNamed', { name: `${r.userName} ${paiseToInput(r.hourlyPaise)}` })} onClick={() => del.mutate(r.id)}><Trash2 size={14} /></button>}</td></tr>)}</tbody></table></div>
    </div>
  );
}
