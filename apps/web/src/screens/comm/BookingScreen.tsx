import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@worko/i18n';
import { Copy, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { useClientContacts } from './CommScreen';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { useUsers } from '../tasks/shared';
import { as, body, useCommError, type Appointment, type BookingPage } from './api';
import { addDays, workingHoursErrors, type WorkingHours } from './logic';
import { NoAccess, StatusBadge } from './shared';

type View = 'pages' | 'appointments';
const DAYS = ['1', '2', '3', '4', '5', '6', '0'] as const;

/** Public booking link for a page (hash route so it works on any static host and in Electron). */
export const bookingLink = (firmSlug: string, slug: string) => `${location.origin}${location.pathname}#/book/${encodeURIComponent(firmSlug)}/${encodeURIComponent(slug)}`;

export function BookingScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  if (!can('communication', 'view')) return <NoAccess />;
  const view: View = params[0] === 'appointments' ? 'appointments' : 'pages';
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p7.nav.booking')}</h1>
      <Tabs<View> label={t('p7.nav.booking')} value={view} onChange={(v) => go(v === 'pages' ? 'booking' : `booking/${v}`)} tabs={[['pages', t('p7.bk.pages')], ['appointments', t('p7.bk.appointments')]]} />
      {view === 'pages' ? <Pages /> : <Appointments />}
    </div>
  );
}

function Pages() {
  const t = useT();
  const can = useCan();
  const me = useMe().data;
  const { name } = useUsers();
  const q = useQuery({ queryKey: ['booking', 'pages'], queryFn: () => as<BookingPage[]>(api.GET('/booking/pages')) });
  const [editing, setEditing] = useState<BookingPage | 'new' | null>(null);
  const copy = async (u: string) => { try { await navigator.clipboard.writeText(u); toast({ text: t('p7.cal.copied'), tone: 'ok' }, 2000); } catch { toast({ text: t('common.error'), tone: 'error' }); } };
  return (
    <div className="space-y-2">
      {can('communication', 'create') && <div className="flex"><button className="btn btn-primary ml-auto" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('p7.bk.new')}</button></div>}
      {!q.isLoading && !q.data?.length && <p className="card p-4 text-muted">{t('p7.bk.none')}</p>}
      <ul className="grid gap-2 md:grid-cols-2">{(q.data ?? []).map((p) => {
        const link = me ? bookingLink(me.firmSlug, p.slug) : '';
        return (
          <li key={p.id} className="card space-y-1 p-3">
            <div className="flex items-center gap-2"><h2 className="flex-1 font-semibold">{p.title}</h2><StatusBadge status={p.active ? 'active' : 'cancelled'} family="pstatus" /></div>
            <p className="text-xs text-muted">{t('p7.bk.summary', { slot: p.slotMinutes, buffer: p.bufferMinutes, horizon: p.horizonDays })} · {p.hostUserIds.map(name).join(', ')}</p>
            <div className="flex flex-wrap gap-1">
              <a className="btn" href={link} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden /> {t('p7.bk.open')}</a>
              <button className="btn" onClick={() => void copy(link)}><Copy size={14} aria-hidden /> {t('p7.bk.copyLink')}</button>
              {can('communication', 'edit') && <button className="btn" onClick={() => setEditing(p)}>{t('p6.edit')}</button>}
            </div>
          </li>
        );
      })}</ul>
      {editing && <PageDialog page={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const defaultHours = (): WorkingHours => Object.fromEntries(['1', '2', '3', '4', '5'].map((d) => [d, [['10:00', '13:00'], ['14:00', '18:00']]])) as WorkingHours;

function PageDialog({ page, onClose }: { page: BookingPage | null; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const me = useMe().data;
  const { users } = useUsers();
  const [slug, setSlug] = useState(page?.slug ?? '');
  const [title, setTitle] = useState(page?.title ?? '');
  const [description, setDescription] = useState(page?.description ?? '');
  const [hosts, setHosts] = useState<string[]>(page?.hostUserIds ?? (me ? [me.id] : []));
  const [slot, setSlot] = useState(page?.slotMinutes ?? 30);
  const [buffer, setBuffer] = useState(page?.bufferMinutes ?? 10);
  const [horizon, setHorizon] = useState(page?.horizonDays ?? 21);
  const [notice, setNotice] = useState(page?.minNoticeMinutes ?? 240);
  const [createTask, setCreateTask] = useState(page?.createTask ?? false);
  const [active, setActive] = useState(page?.active ?? true);
  const [wh, setWh] = useState<WorkingHours>((page?.workingHours as WorkingHours) ?? defaultHours());
  const whErr = workingHoursErrors(wh);
  const badSlug = !/^[a-z0-9-]{2,60}$/.test(slug);
  const save = useMutation({
    mutationFn: () => {
      const b = { slug, title: title.trim(), description: description.trim() || null, hostUserIds: hosts, slotMinutes: slot, bufferMinutes: buffer, workingHours: wh, horizonDays: horizon, minNoticeMinutes: notice, createTask, active };
      return page ? as(api.PATCH('/booking/pages/{id}', { params: { path: { id: page.id } }, body: body(b) })) : as(api.POST('/booking/pages', { body: body(b) }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['booking'] }); toast({ text: t('p6.saved'), tone: 'ok' }, 2000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const setRange = (d: string, k: number, i: 0 | 1, v: string) => setWh({ ...wh, [d]: (wh[d as keyof WorkingHours] ?? []).map((r, j) => (j === k ? (i ? [r[0], v] : [v, r[1]]) as [string, string] : r)) });
  const dayName = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 1 + Number(d)))); // 1 Nov 2026 = Sunday
  return (
    <Dialog title={page ? t('p7.bk.edit') : t('p7.bk.new')} onClose={onClose} wide>
      <form className="grid gap-3 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (!badSlug && title.trim() && hosts.length && !whErr.length) save.mutate(); }}>
        <div className="space-y-3">
          <Field label={t('p7.cal.title')}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
          <Field label={t('p7.bk.slug')} hint={me ? `#/book/${me.firmSlug}/${slug || '…'}` : undefined} error={slug && badSlug ? t('p7.bk.badSlug') : null}><input className="input font-mono" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} required /></Field>
          <Field label={t('p7.cal.description')}><textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <NumField label={t('p7.bk.slotMinutes')} value={slot} min={10} max={480} onChange={setSlot} />
            <NumField label={t('p7.bk.buffer')} value={buffer} min={0} max={240} onChange={setBuffer} />
            <NumField label={t('p7.bk.horizon')} value={horizon} min={1} max={180} onChange={setHorizon} />
            <NumField label={t('p7.bk.notice')} value={notice} min={0} max={20160} onChange={setNotice} />
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={createTask} onChange={(e) => setCreateTask(e.target.checked)} /> {t('p7.bk.createTask')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('p7.bk.active')}</label>
          <fieldset><legend className="label">{t('p7.bk.hosts')}</legend><div className="max-h-28 space-y-0.5 overflow-auto">{users.map((u) => (
            <label key={u.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hosts.includes(u.id)} onChange={() => setHosts(hosts.includes(u.id) ? hosts.filter((x) => x !== u.id) : [...hosts, u.id])} /> {u.name}</label>))}</div>
            <p className="text-xs text-muted">{t('p7.bk.hostsNote')}</p></fieldset>
        </div>
        <fieldset className="space-y-1"><legend className="label">{t('p7.bk.hours')}</legend>
          {DAYS.map((d) => (
            <div key={d} className="flex flex-wrap items-center gap-1" data-testid={`wh-${d}`}>
              <span className="w-10 text-sm">{dayName(d)}</span>
              {(wh[d] ?? []).map((r, k) => <span key={k} className="flex items-center gap-0.5">
                <input type="time" aria-label={t('p7.bk.rangeStart', { day: dayName(d) })} className="input w-24 py-0.5" value={r[0]} onChange={(e) => setRange(d, k, 0, e.target.value)} />–
                <input type="time" aria-label={t('p7.bk.rangeEnd', { day: dayName(d) })} className="input w-24 py-0.5" value={r[1]} onChange={(e) => setRange(d, k, 1, e.target.value)} />
                <button type="button" aria-label={t('p6.delete')} onClick={() => setWh({ ...wh, [d]: (wh[d] ?? []).filter((_, j) => j !== k) })}><Trash2 size={12} /></button></span>)}
              {(wh[d]?.length ?? 0) < 6 && <button type="button" className="text-xs text-primary underline" onClick={() => setWh({ ...wh, [d]: [...(wh[d] ?? []), ['10:00', '13:00']] })}>{t('p7.bk.addRange')}</button>}
              {!wh[d]?.length && <span className="text-xs text-muted">{t('p7.bk.closed')}</span>}
            </div>
          ))}
          {whErr.length > 0 && <p role="alert" className="text-sm text-overdue">{t('p7.bk.badHours')}</p>}
          <p className="text-xs text-muted">{t('p7.bk.hoursNote')}</p>
        </fieldset>
        <div className="flex justify-end gap-2 md:col-span-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={badSlug || !title.trim() || !hosts.length || whErr.length > 0 || save.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

function NumField({ label, value, onChange, min, max }: { label: string; value: number; onChange(v: number): void; min: number; max: number }) {
  return <Field label={label}><input type="number" className="input" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Math.floor(Number(e.target.value) || 0))))} /></Field>;
}

function Appointments() {
  const t = useT();
  const { name } = useUsers();
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(addDays(todayIst(), 30));
  const q = useQuery({ queryKey: ['booking', 'appointments', from, to], queryFn: () => as<Appointment[]>(api.GET('/booking/appointments', { params: { query: { from, to } } })) });
  const pages = useQuery({ queryKey: ['booking', 'pages'], queryFn: () => as<BookingPage[]>(api.GET('/booking/pages')) }).data ?? [];
  const [linking, setLinking] = useState<Appointment | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Field label={t('p6.f.from')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('p6.f.to')}><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p7.bk.appointments')}>
        <thead><tr><th>{t('p7.bk.when')}</th><th>{t('p7.pub.name')}</th><th>{t('p7.pub.purpose')}</th><th>{t('p7.bk.page')}</th><th>{t('p7.bk.host')}</th><th>{t('p6.f.status')}</th><th>{t('p6.f.client')}</th></tr></thead>
        <tbody>{(q.data ?? []).map((a) => (
          <tr key={a.id}><td>{formatDateTime(a.startsAt)}</td>
            <td>{a.clientId ? <a className="underline" href={`#/clients/${a.clientId}`}>{a.name}</a> : a.name}<span className="block text-xs text-muted">{[a.email, a.phone].filter(Boolean).join(' · ')}</span></td>
            <td className="max-w-xs truncate" title={a.purpose}>{a.purpose}</td><td>{pages.find((p) => p.id === a.pageId)?.title ?? '—'}</td><td>{name(a.hostUserId)}</td>
            <td><StatusBadge status={a.status} family="astatus" />{a.reschedules > 0 && <span className="block text-xs text-muted">{t('p7.bk.rescheduled', { n: a.reschedules })}</span>}</td>
            <td>{a.clientId ? t('p7.bk.linked') : <button className="btn" onClick={() => setLinking(a)}>{a.suggestedClientId ? t('p7.bk.confirmSuggested') : t('p7.bk.linkClient')}</button>}</td></tr>
        ))}</tbody>
      </table></div>
      {!q.isLoading && !q.data?.length && <p className="text-sm text-muted">{t('p7.bk.noAppointments')}</p>}
      {linking && <LinkClientDialog ap={linking} onClose={() => setLinking(null)} />}
    </div>
  );
}

/** Booker details are unverified: a matched client is only a suggestion until staff confirm it (D108). */
function LinkClientDialog({ ap, onClose }: { ap: Appointment; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const suggested = useClientContacts(ap.suggestedClientId ?? null).data;
  const [client, setClient] = useState<PickedClient | null>(null);
  const pick = client ?? (suggested ? { id: suggested.id, name: suggested.name } : null);
  const m = useMutation({
    mutationFn: () => as(api.POST('/booking/appointments/{id}/link-client', { params: { path: { id: ap.id } }, body: body({ clientId: pick!.id }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['booking', 'appointments'] }); toast({ text: t('p7.bk.linkedOk'), tone: 'ok' }, 3000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p7.bk.linkTitle', { name: ap.name })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (pick) m.mutate(); }}>
        <p className="text-xs text-muted">{t('p7.bk.unverified')}</p>
        {suggested && !client && <p className="text-sm">{t('p7.bk.suggested', { name: suggested.name })}</p>}
        <ClientPicker label={t('p6.f.client')} value={client} onChange={setClient} />
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!pick || m.isPending}>{t('p7.bk.linkClient')}</button></div>
      </form>
    </Dialog>
  );
}
