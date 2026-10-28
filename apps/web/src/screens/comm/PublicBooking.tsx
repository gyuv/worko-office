import { useMutation, useQuery } from '@tanstack/react-query';
import { PRODUCT } from '@worko/domain';
import { formatDateTime } from '@worko/i18n';
import { useState, type ReactNode } from 'react';
import { Field } from '../../components/Dialog';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/session';
import { as, body, useCommError } from './api';
import { addDays, fromLocalInput, groupSlots } from './logic';

type Slots = { firm: string; title: string; description: string | null; slotMinutes: number; from: string; to: string; slots: string[] };
type Booked = { id: string; startsAt: string; endsAt: string; manageToken: string; manageUrl: string };
type Manage = { status: string; startsAt: string; endsAt: string; purpose: string; page: string; slug: string; firm: string };

const dayTitle = (day: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(`${day}T12:00:00+05:30`));
const manageHref = (token: string, firm?: string) => `#/book/manage/${encodeURIComponent(token)}${firm ? `?firm=${encodeURIComponent(firm)}` : ''}`;

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-4 bg-bg p-4 text-fg">
      {children}
      <footer className="pt-6 text-center text-xs text-muted">{PRODUCT.name}</footer>
    </main>
  );
}

/** Slot picker: one fortnight at a time, grouped by IST day. */
function SlotPicker({ firm, slug, value, onPick }: { firm: string; slug: string; value: string | null; onPick(iso: string): void }) {
  const t = useT();
  const [from, setFrom] = useState<string | undefined>(undefined);
  const q = useQuery({ queryKey: ['book', firm, slug, from], retry: false,
    queryFn: () => as<Slots>(api.GET('/book/{firm}/{slug}', { params: { path: { firm, slug }, query: from ? { from, to: addDays(from, 13) } : {} } })) });
  if (q.isError) return <p role="alert" className="card p-4">{t('p7.pub.notFound')}</p>;
  if (!q.data) return <p className="text-muted">{t('common.loading')}</p>;
  const groups = groupSlots(q.data.slots);
  return (
    <div className="space-y-2">
      {!groups.length && <p className="card p-4 text-muted">{t('p7.pub.noSlots')}</p>}
      <div className="grid gap-2 sm:grid-cols-2">{groups.map((g) => (
        <section key={g.day} className="card p-2" aria-label={dayTitle(g.day)}>
          <h3 className="mb-1 text-sm font-medium">{dayTitle(g.day)}</h3>
          <div className="flex flex-wrap gap-1">{g.slots.map((s) => (
            <button key={s.iso} type="button" aria-pressed={value === s.iso} onClick={() => onPick(s.iso)}
              className={`rounded border px-2 py-1 text-sm tabular-nums ${value === s.iso ? 'border-primary bg-primary text-primary-fg' : 'border-border hover:bg-surface-alt'}`}>{s.time}</button>
          ))}</div>
        </section>
      ))}</div>
      <div className="flex justify-between">
        {from ? <button className="btn" onClick={() => setFrom(addDays(from, -14) <= q.data!.from ? undefined : addDays(from, -14))}>{t('p6.prev')}</button> : <span />}
        <button className="btn" onClick={() => setFrom(addDays(q.data!.to, 1))}>{t('p7.pub.later')}</button>
      </div>
    </div>
  );
}

/** Public booking page (no login): `#/book/{firm}/{slug}`. */
export function PublicBook({ firm, slug }: { firm: string; slug: string }) {
  const t = useT();
  const err = useCommError();
  const info = useQuery({ queryKey: ['book', firm, slug, undefined], retry: false, queryFn: () => as<Slots>(api.GET('/book/{firm}/{slug}', { params: { path: { firm, slug }, query: {} } })) });
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [purpose, setPurpose] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const book = useMutation({
    mutationFn: () => as<Booked>(api.POST('/book/{firm}/{slug}', { params: { path: { firm, slug } }, body: body({ startsAt: slot!, name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, purpose: purpose.trim(), consent }) })),
    onError: (e) => setError(err(e)),
  });
  if (book.data) return (
    <Frame>
      <div role="status" className="card space-y-2 p-4" data-testid="booked">
        <h1 className="text-xl font-semibold">{t('p7.pub.confirmed')}</h1>
        <p>{t('p7.pub.confirmedAt', { at: formatDateTime(book.data.startsAt) })}</p>
        <p className="text-sm text-muted">{t('p7.pub.manageHint')}</p>
        <a className="btn" href={manageHref(book.data.manageToken, firm)}>{t('p7.pub.manage')}</a>
      </div>
    </Frame>
  );
  const okContact = !!email.trim() || !!phone.trim();
  const ok = !!slot && !!name.trim() && okContact && purpose.trim().length >= 3;
  return (
    <Frame>
      {info.data && <header><p className="text-sm text-muted">{info.data.firm}</p><h1 className="text-2xl font-semibold">{info.data.title}</h1>
        {info.data.description && <p className="text-sm">{info.data.description}</p>}
        <p className="text-xs text-muted">{t('p7.pub.duration', { n: info.data.slotMinutes })} · {t('p7.pub.ist')}</p></header>}
      <SlotPicker firm={firm} slug={slug} value={slot} onPick={(s) => { setSlot(s); setError(null); }} />
      {info.data && <form className="card space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); setError(null); if (ok) book.mutate(); }} aria-label={t('p7.pub.yourDetails')}>
        <h2 className="font-semibold">{t('p7.pub.yourDetails')}</h2>
        {slot ? <p className="text-sm" data-testid="picked">{t('p7.pub.picked', { at: formatDateTime(slot) })}</p> : <p className="text-sm text-muted">{t('p7.pub.pickSlot')}</p>}
        <Field label={t('p7.pub.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('p7.pub.email')}><input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
          <Field label={t('p7.pub.phone')}><input type="tel" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></Field>
        </div>
        {!okContact && (name || purpose) && <p className="text-xs text-due-soon">{t('p7.err.contact_required')}</p>}
        <Field label={t('p7.pub.purpose')} hint={t('p7.pub.purposeHint')}><textarea className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} required minLength={3} /></Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {t('p7.pub.consent')}</label>
        {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
        <button className="btn btn-primary" disabled={!ok || book.isPending}>{t('p7.pub.book')}</button>
      </form>}
    </Frame>
  );
}

/** Manage page (no login): `#/book/manage/{token}` — reschedule or cancel. */
export function ManageBooking({ token, firmSlug }: { token: string; firmSlug?: string }) {
  const t = useT();
  const err = useCommError();
  const [tok, setTok] = useState(token);
  const q = useQuery({ queryKey: ['book', 'manage', tok], retry: false, queryFn: () => as<Manage>(api.GET('/book/manage/{token}', { params: { path: { token: tok } } })) });
  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const [slot, setSlot] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const reschedule = useMutation({
    mutationFn: (startsAt: string) => as<Booked>(api.POST('/book/manage/{token}/reschedule', { params: { path: { token: tok } }, body: body({ startsAt }) })),
    onSuccess: (r) => { setTok(r.manageToken); setMode('view'); setMsg({ text: t('p7.pub.rescheduled', { at: formatDateTime(r.startsAt) }), tone: 'ok' }); history.replaceState(null, '', manageHref(r.manageToken, firmSlug)); },
    onError: (e) => setMsg({ text: err(e), tone: 'error' }),
  });
  const cancel = useMutation({
    mutationFn: () => as(api.POST('/book/manage/{token}/cancel', { params: { path: { token: tok } } })),
    onSuccess: () => { setMsg({ text: t('p7.pub.cancelled'), tone: 'ok' }); void q.refetch(); },
    onError: (e) => setMsg({ text: err(e), tone: 'error' }),
  });
  if (q.isError) return <Frame><p role="alert" className="card p-4">{t('p7.pub.linkInvalid')}</p></Frame>;
  if (!q.data) return <Frame><p className="text-muted">{t('common.loading')}</p></Frame>;
  const a = q.data;
  const active = a.status !== 'cancelled';
  const startsAt = mode === 'reschedule' ? slot ?? fromLocalInput(manual) : null;
  return (
    <Frame>
      <header><p className="text-sm text-muted">{a.firm}</p><h1 className="text-2xl font-semibold">{a.page}</h1></header>
      <div className="card space-y-1 p-4" data-testid="manage">
        <p>{t('p7.pub.when', { at: formatDateTime(a.startsAt) })}</p>
        <p className="text-sm text-muted">{a.purpose}</p>
        <p className="text-sm">{t('p7.pub.status', { status: t(`p7.pub.st.${a.status === 'cancelled' ? 'cancelled' : 'booked'}`) })}</p>
      </div>
      {msg && <p role={msg.tone === 'error' ? 'alert' : 'status'} className={msg.tone === 'error' ? 'text-overdue' : 'text-done'}>{msg.text}</p>}
      {active && mode === 'view' && <div className="flex gap-2">
        <button className="btn" onClick={() => { setMode('reschedule'); setMsg(null); }}>{t('p7.pub.reschedule')}</button>
        <button className="btn btn-danger" disabled={cancel.isPending} onClick={() => confirm(t('p7.pub.cancelConfirm')) && cancel.mutate()}>{t('p7.pub.cancel')}</button></div>}
      {active && mode === 'reschedule' && <div className="space-y-3">
        {firmSlug ? <SlotPicker firm={firmSlug} slug={a.slug} value={slot} onPick={setSlot} />
          : <Field label={t('p7.pub.newTime')} hint={t('p7.pub.ist')}><input type="datetime-local" className="input w-64" value={manual} onChange={(e) => setManual(e.target.value)} /></Field>}
        <div className="flex gap-2"><button className="btn" onClick={() => setMode('view')}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!startsAt || reschedule.isPending} onClick={() => startsAt && reschedule.mutate(startsAt)}>{t('p7.pub.confirmReschedule')}</button></div>
      </div>}
    </Frame>
  );
}
