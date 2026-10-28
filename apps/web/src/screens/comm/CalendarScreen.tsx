import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime } from '@worko/i18n';
import { ChevronLeft, ChevronRight, Copy, Plus } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { useSync } from '../../lib/sync';
import { useUsers } from '../tasks/shared';
import { as, body, useCommError, type Feed } from './api';
import { addDays, fromLocalInput, istTime, itemsOnDay, layoutWeek, monthGrid, toLocalInput, weekDays, type CalItem } from './logic';

type Mode = 'week' | 'month' | 'feeds';
const TONE: Record<CalItem['source'], string> = { event: 'border-primary bg-primary/10', task: 'border-due-soon bg-due-soon/10', leave: 'border-waiting bg-waiting/10', holiday: 'border-done bg-done/10' };
const HOUR = 40; // px per hour

/** Calendar (D107): own/attended events plus read-only task due dates, own leave and holidays. */
export function CalendarScreen() {
  const t = useT();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  const mode: Mode = params[0] === 'month' ? 'month' : params[0] === 'feeds' ? 'feeds' : 'week';
  const [anchor, setAnchor] = useState(todayIst());
  const [editing, setEditing] = useState<CalItem | 'new' | null>(null);
  const days = weekDays(anchor);
  const grid = monthGrid(anchor.slice(0, 7));
  const from = mode === 'month' ? grid[0]![0]! : days[0]!;
  const to = mode === 'month' ? grid[5]![6]! : days[6]!;
  const v = useSync((s) => s.versions.calendar_event ?? 0);
  const q = useQuery({ queryKey: ['calendar', from, to, v], enabled: mode !== 'feeds', queryFn: () => as<CalItem[]>(api.GET('/calendar/events', { params: { query: { from, to } } })) });
  const items = q.data ?? [];
  const step = (k: number) => setAnchor(mode === 'month' ? `${addDays(`${anchor.slice(0, 7)}-15`, k * 30).slice(0, 7)}-01` : addDays(anchor, k * 7));
  const [responding, setResponding] = useState<CalItem | null>(null);
  const open = (i: CalItem) => { if (i.invited) setResponding(i); else if (i.source === 'event' && i.editable) setEditing(i); else if (i.source === 'task') go('tasks'); };
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('p7.nav.calendar')}</h1>
        {mode !== 'feeds' && <div className="flex items-center gap-1">
          <button className="btn" aria-label={t('p6.prev')} onClick={() => step(-1)}><ChevronLeft size={14} /></button>
          <button className="btn" onClick={() => setAnchor(todayIst())}>{t('p7.cal.today')}</button>
          <button className="btn" aria-label={t('p6.next')} onClick={() => step(1)}><ChevronRight size={14} /></button>
          <span className="ml-2 text-sm" data-testid="cal-range">{mode === 'month' ? formatMonth(anchor) : `${formatDate(`${days[0]}T12:00:00+05:30`)} – ${formatDate(`${days[6]}T12:00:00+05:30`)}`}</span>
        </div>}
        <button className="btn btn-primary ml-auto" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('p7.cal.newMeeting')}</button>
      </header>
      <Tabs<Mode> label={t('p7.nav.calendar')} value={mode} onChange={(m) => go(m === 'week' ? 'calendar' : `calendar/${m}`)} tabs={[['week', t('p7.cal.week')], ['month', t('p7.cal.month')], ['feeds', t('p7.cal.feeds')]]} />
      <Legend />
      {mode === 'week' && <WeekView days={days} items={items} onOpen={open} />}
      {mode === 'month' && <MonthView grid={grid} month={anchor.slice(0, 7)} items={items} onOpen={open} onDay={(d) => { setAnchor(d); go('calendar'); }} />}
      {mode === 'feeds' && <Feeds />}
      {responding && <RespondDialog item={responding} onClose={() => setResponding(null)} />}
      {editing && <EventDialog item={editing === 'new' ? null : editing} day={anchor} onClose={() => setEditing(null)} />}
    </div>
  );
}

const formatMonth = (day: string) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(`${day.slice(0, 7)}-15T12:00:00+05:30`));
const dayLabel = (day: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(`${day}T12:00:00+05:30`));

function Legend() {
  const t = useT();
  return <ul className="flex flex-wrap gap-3 text-xs">{(['event', 'task', 'leave', 'holiday'] as const).map((s) => <li key={s} className="flex items-center gap-1"><span className={`inline-block h-3 w-3 rounded border ${TONE[s]}`} />{t(`p7.cal.src.${s}`)}</li>)}</ul>;
}

function Chip({ i, onOpen }: { i: CalItem; onOpen(i: CalItem): void }) {
  return (
    <button type="button" onClick={() => onOpen(i)} title={i.clientName ? `${i.title} — ${i.clientName}` : i.title} data-source={i.source}
      className={`block w-full truncate rounded border-l-2 px-1 text-left text-xs ${TONE[i.source]}`}>
      {!i.allDay && <span className="tabular-nums">{istTime(i.startsAt)} </span>}{i.invited ? '? ' : ''}{i.title}
    </button>
  );
}

function WeekView({ days, items, onOpen }: { days: string[]; items: CalItem[]; onOpen(i: CalItem): void }) {
  const t = useT();
  const cols = layoutWeek(items, days);
  const today = todayIst();
  return (
    <div className="card overflow-auto" role="grid" aria-label={t('p7.cal.week')}>
      <div className="grid min-w-[42rem] grid-cols-[3rem_repeat(7,1fr)]">
        <div />
        {cols.map((c) => <div key={c.day} role="columnheader" className={`border-b border-l border-border p-1 text-center text-xs ${c.day === today ? 'font-semibold text-primary' : ''}`}>{dayLabel(c.day)}</div>)}
        <div className="text-right text-xs text-muted">{t('p7.cal.allDay')}</div>
        {cols.map((c) => <div key={c.day} className="space-y-0.5 border-b border-l border-border p-0.5" data-testid={`allday-${c.day}`}>{c.allDay.map((i) => <Chip key={`${i.source}:${i.id}`} i={i} onOpen={onOpen} />)}</div>)}
        <div className="relative" style={{ height: 24 * HOUR }}>{Array.from({ length: 24 }, (_, h) => <div key={h} className="absolute right-1 text-xs text-muted" style={{ top: h * HOUR }}>{String(h).padStart(2, '0')}:00</div>)}</div>
        {cols.map((c) => (
          <div key={c.day} className="relative border-l border-border" style={{ height: 24 * HOUR }} data-testid={`day-${c.day}`}>
            {Array.from({ length: 24 }, (_, h) => <div key={h} className="absolute inset-x-0 border-t border-border/50" style={{ top: h * HOUR }} />)}
            {c.timed.map((i) => (
              <div key={`${i.source}:${i.id}`} className="absolute px-0.5" style={{ top: (i.top / 60) * HOUR, height: Math.max(16, (i.height / 60) * HOUR), left: `${(i.lane / i.lanes) * 100}%`, width: `${100 / i.lanes}%` }}>
                <button type="button" onClick={() => onOpen(i)} className={`h-full w-full overflow-hidden rounded border-l-2 px-1 text-left text-xs ${TONE[i.source]}`}>
                  <span className="tabular-nums">{istTime(i.startsAt)}</span> {i.invited ? '? ' : ''}{i.title}{i.clientName && <span className="block text-muted">{i.clientName}</span>}</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthView({ grid, month, items, onOpen, onDay }: { grid: string[][]; month: string; items: CalItem[]; onOpen(i: CalItem): void; onDay(d: string): void }) {
  const t = useT();
  const today = todayIst();
  return (
    <div className="card overflow-auto" role="grid" aria-label={t('p7.cal.month')}>
      <div className="grid min-w-[42rem] grid-cols-7">
        {grid[0]!.map((d) => <div key={d} className="border-b border-border p-1 text-center text-xs text-muted">{new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(`${d}T12:00:00+05:30`))}</div>)}
        {grid.flat().map((d) => {
          const list = itemsOnDay(items, d);
          return (
            <div key={d} role="gridcell" className={`min-h-24 border-b border-l border-border p-1 ${d.slice(0, 7) !== month ? 'opacity-50' : ''}`} data-testid={`mday-${d}`}>
              <button className={`text-xs ${d === today ? 'font-semibold text-primary' : ''}`} onClick={() => onDay(d)}>{Number(d.slice(8))}</button>
              <div className="space-y-0.5">{list.slice(0, 3).map((i) => <Chip key={`${i.source}:${i.id}`} i={i} onOpen={onOpen} />)}
                {list.length > 3 && <button className="text-xs text-muted" onClick={() => onDay(d)}>{t('p7.cal.more', { n: list.length - 3 })}</button>}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventDialog({ item, day, onClose }: { item: CalItem | null; day: string; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const me = useMe().data;
  const { users } = useUsers();
  const [title, setTitle] = useState(item?.title ?? '');
  const [kind, setKind] = useState<'meeting' | 'personal'>(item?.kind === 'personal' ? 'personal' : 'meeting');
  const [allDay, setAllDay] = useState(item?.allDay ?? false);
  const [start, setStart] = useState(item ? toLocalInput(item.startsAt) : `${day}T11:00`);
  const [end, setEnd] = useState(item ? toLocalInput(item.endsAt) : `${day}T11:30`);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [client, setClient] = useState<PickedClient | null>(item?.clientId ? { id: item.clientId, name: item.clientName ?? '' } : null);
  const [attendees, setAttendees] = useState<string[]>([]);
  const s = fromLocalInput(allDay ? `${start.slice(0, 10)}T00:00` : start);
  const e = fromLocalInput(allDay ? `${end.slice(0, 10)}T23:59` : end);
  const bad = !s || !e || Date.parse(e) < Date.parse(s);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['calendar'] });
  const save = useMutation({
    mutationFn: () => {
      const b = { kind, title: title.trim(), startsAt: s!, endsAt: e!, allDay, clientId: client?.id ?? null,
        ...(location.trim() ? { location: location.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}), ...(attendees.length || !item ? { attendeeIds: attendees } : {}) };
      return item ? as(api.PATCH('/calendar/events/{id}', { params: { path: { id: item.id } }, body: body(b) })) : as(api.POST('/calendar/events', { body: body(b) }));
    },
    onSuccess: () => { refresh(); toast({ text: t('p6.saved'), tone: 'ok' }, 2000); onClose(); },
    onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  const del = useMutation({
    mutationFn: () => as(api.DELETE('/calendar/events/{id}', { params: { path: { id: item!.id } } })),
    onSuccess: () => { refresh(); onClose(); }, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  return (
    <Dialog title={item ? t('p7.cal.editEvent') : t('p7.cal.newMeeting')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(ev) => { ev.preventDefault(); if (title.trim() && !bad) save.mutate(); }}>
        <Field label={t('p7.cal.title')}><input className="input" value={title} onChange={(x) => setTitle(x.target.value)} required /></Field>
        <div className="flex gap-4">
          <label className="flex items-center gap-2"><input type="radio" checked={kind === 'meeting'} onChange={() => setKind('meeting')} /> {t('p7.cal.meeting')}</label>
          <label className="flex items-center gap-2"><input type="radio" checked={kind === 'personal'} onChange={() => setKind('personal')} /> {t('p7.cal.personal')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={allDay} onChange={(x) => setAllDay(x.target.checked)} /> {t('p7.cal.allDay')}</label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('p7.cal.starts')}><input type={allDay ? 'date' : 'datetime-local'} className="input" value={allDay ? start.slice(0, 10) : start} onChange={(x) => setStart(allDay ? `${x.target.value}T00:00` : x.target.value)} /></Field>
          <Field label={t('p7.cal.ends')} error={bad ? t('p7.cal.badRange') : null}><input type={allDay ? 'date' : 'datetime-local'} className="input" value={allDay ? end.slice(0, 10) : end} onChange={(x) => setEnd(allDay ? `${x.target.value}T23:59` : x.target.value)} /></Field>
        </div>
        <p className="text-xs text-muted">{t('p7.cal.istNote')}</p>
        <Field label={t('p7.cal.location')}><input className="input" value={location} onChange={(x) => setLocation(x.target.value)} /></Field>
        <ClientPicker label={t('p7.cal.client')} value={client} onChange={setClient} />
        {kind === 'meeting' && <fieldset><legend className="label">{t('p7.cal.attendees')}</legend><div className="max-h-32 space-y-0.5 overflow-auto">
          {users.filter((u) => u.id !== me?.id).map((u) => <label key={u.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={attendees.includes(u.id)}
            onChange={() => setAttendees(attendees.includes(u.id) ? attendees.filter((x) => x !== u.id) : [...attendees, u.id])} /> {u.name}</label>)}</div></fieldset>}
        <Field label={t('p7.cal.description')}><textarea className="input" value={description} onChange={(x) => setDescription(x.target.value)} /></Field>
        <div className="flex justify-between gap-2">
          {item ? <button type="button" className="btn btn-danger" onClick={() => del.mutate()}>{t('p6.delete')}</button> : <span />}
          <div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-primary" disabled={!title.trim() || bad || save.isPending}>{t('common.save')}</button></div>
        </div>
      </form>
    </Dialog>
  );
}

/** Invitations stay out of feeds and free/busy until accepted (D107). */
function RespondDialog({ item, onClose }: { item: CalItem; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const m = useMutation({
    mutationFn: (accept: boolean) => as(api.POST('/calendar/events/{id}/respond', { params: { path: { id: item.id } }, body: body({ accept }) })),
    onSuccess: (_r, accept) => { void qc.invalidateQueries({ queryKey: ['calendar'] }); toast({ text: accept ? t('p7.cal.accepted') : t('p7.cal.declined'), tone: 'ok' }, 3000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p7.cal.invitation')} onClose={onClose}>
      <p className="font-medium">{item.title}</p>
      <p className="mb-3 text-sm text-muted">{formatDateTime(item.startsAt)}{item.clientName ? ` · ${item.clientName}` : ''}</p>
      <div className="flex justify-end gap-2"><button className="btn btn-danger" disabled={m.isPending} onClick={() => m.mutate(false)}>{t('p7.cal.decline')}</button>
        <button className="btn btn-primary" disabled={m.isPending} onClick={() => m.mutate(true)}>{t('p7.cal.accept')}</button></div>
    </Dialog>
  );
}

function Feeds() {
  const t = useT();
  const qc = useQueryClient();
  const err = useCommError();
  const q = useQuery({ queryKey: ['calendar', 'feeds'], queryFn: () => as<Feed[]>(api.GET('/calendar/feeds')) });
  const [label, setLabel] = useState('');
  const [mask, setMask] = useState(true);
  const [fresh, setFresh] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => as<{ id: string; url: string }>(api.POST('/calendar/feeds', { body: body({ label: label.trim() || null, maskClients: mask }) })),
    onSuccess: (r) => { setFresh(r.url); setLabel(''); void qc.invalidateQueries({ queryKey: ['calendar', 'feeds'] }); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => as(api.DELETE('/calendar/feeds/{id}', { params: { path: { id } } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['calendar', 'feeds'] }); toast({ text: t('p7.cal.feedRevoked'), tone: 'ok' }, 3000); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const copy = async (u: string) => { try { await navigator.clipboard.writeText(u); toast({ text: t('p7.cal.copied'), tone: 'ok' }, 2000); } catch { toast({ text: t('common.error'), tone: 'error' }); } };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t('p7.cal.feedHint')}</p>
      <form className="card flex flex-wrap items-end gap-3 p-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label={t('p7.cal.feedLabel')}><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('p7.cal.feedLabelPh')} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} /> {t('p7.cal.maskClients')}</label>
        <button className="btn btn-primary" disabled={create.isPending}>{t('p7.cal.createFeed')}</button>
      </form>
      {fresh && <div role="status" className="card space-y-1 border-primary p-3">
        <p className="text-sm font-medium">{t('p7.cal.feedOnce')}</p>
        <div className="flex gap-2"><input className="input flex-1 font-mono text-xs" readOnly value={fresh} aria-label={t('p7.cal.feedUrl')} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => void copy(fresh)}><Copy size={14} aria-hidden /> {t('p7.cal.copy')}</button></div>
      </div>}
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p7.cal.feeds')}>
        <thead><tr><th>{t('p7.cal.feedLabel')}</th><th>{t('p7.cal.maskClients')}</th><th>{t('p7.cal.created')}</th><th>{t('p7.cal.lastUsed')}</th><th /></tr></thead>
        <tbody>{(q.data ?? []).map((f) => (
          <tr key={f.id} className={f.revokedAt ? 'text-muted' : ''}><td>{f.label ?? '—'}</td><td>{f.maskClients ? t('p7.yes') : t('p7.no')}</td><td>{formatDateTime(f.createdAt)}</td>
            <td>{f.lastUsedAt ? formatDateTime(f.lastUsedAt) : t('common.never')}</td>
            <td className="text-right">{f.revokedAt ? t('p7.cal.revokedOn', { date: formatDate(f.revokedAt) }) : <button className="btn btn-danger" onClick={() => revoke.mutate(f.id)}>{t('p7.conn.revoke')}</button>}</td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

