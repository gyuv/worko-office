import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { defaultPortalGrants, PORTAL_ACCENTS, type PortalGrants, type PortalSettings } from '@worko/domain';
import { formatDate, formatDateTime, type MessageKey } from '@worko/i18n';
import { portalAccents } from '@worko/ui-tokens';
import { Fragment, useEffect, useReducer, useRef, useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Field } from '../../components/Dialog';
import { multipart } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { api } from '../../lib/session';
import { GRANT_FLAGS, grantsReducer, invalidFys, listToText, sameGrants } from '../../portal/logic';
import { as, asFull, body } from '../leads/api';

type Access = { id: string; clientId: string; clientName: string; contactId: string | null; grants: PortalGrants; revokedAt: string | null };
type PortalUser = { id: string; name: string; email: string | null; phone: string | null; status: string; lastLoginAt: string | null; access: Access[] };
type ProfileReq = { id: string; clientId: string; clientName: string; requestedBy: string; fields: string[]; status: string; changes: Record<string, string | null>; createdAt: string; reason: string | null };
type ThreadMsg = { id: string; direction: 'in' | 'out' | 'internal'; body: string; at: string };

const portalLink = (slug: string) => `${location.origin}${location.pathname}#/portal/${slug}`;

/** Settings → Portal: white-label + per-client switch. Firm-wide settings:edit to save. */
export function PortalSettingsPanel() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const me = useMe();
  const q = useQuery({ queryKey: ['portal-admin', 'settings'], queryFn: () => as<PortalSettings>(api.GET('/portal-admin/settings')) });
  const [s, setS] = useState<PortalSettings | null>(null);
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);
  const save = useMutation({
    mutationFn: (v: PortalSettings) => as<PortalSettings>(api.PUT('/portal-admin/settings', { body: body(v) })),
    onSuccess: (v) => { qc.setQueryData(['portal-admin', 'settings'], v); },
  });
  const file = useRef<HTMLInputElement>(null);
  const logo = useMutation({
    mutationFn: async (f: File) => (await as<{ id: string }>(api.POST('/documents', { body: multipart({ file: f, category: 'Branding' }) }))).id,
    onSuccess: (id) => setS((x) => (x ? { ...x, logoDocumentId: id } : x)),
  });
  const editable = can('settings', 'edit');
  if (!s) return <p className="text-muted">{t('common.loading')}</p>;
  const set = <K extends keyof PortalSettings>(k: K, v: PortalSettings[K]) => setS({ ...s, [k]: v });
  const str = (v: string) => (v.trim() ? v.trim() : null);
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p9.ps.title')}</h1>
      {me.data && <p className="text-sm">{t('p9.ps.link')} <a className="underline" href={`#/portal/${me.data.firmSlug}`} target="_blank" rel="noreferrer">{portalLink(me.data.firmSlug)}</a></p>}
      <form className="card space-y-3 p-4" aria-label={t('p9.ps.brand')} onSubmit={(e) => { e.preventDefault(); save.mutate(s); }}>
        <fieldset disabled={!editable} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('p9.ps.name')} hint={t('p9.ps.nameHint')}><input className="input" value={s.displayName ?? ''} onChange={(e) => set('displayName', str(e.target.value))} maxLength={120} /></Field>
            <Field label={t('p9.ps.domain')} hint={t('p9.ps.domainHint')}><input className="input" value={s.customDomain ?? ''} onChange={(e) => set('customDomain', str(e.target.value))} placeholder="portal.example.in" /></Field>
            <Field label={t('p9.ps.supportEmail')}><input className="input" type="email" value={s.supportEmail ?? ''} onChange={(e) => set('supportEmail', str(e.target.value))} /></Field>
            <Field label={t('p9.ps.supportPhone')}><input className="input" value={s.supportPhone ?? ''} onChange={(e) => set('supportPhone', str(e.target.value))} /></Field>
          </div>
          <Field label={t('p9.ps.welcome')}><textarea className="input" value={s.welcomeText ?? ''} onChange={(e) => set('welcomeText', str(e.target.value))} maxLength={1000} /></Field>
          <fieldset><legend className="label">{t('p9.ps.accent')}</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('p9.ps.accent')}>
              {PORTAL_ACCENTS.map((a) => (
                <button key={a} type="button" role="radio" aria-checked={s.accent === a} aria-label={t(`p9.accent.${a}` as MessageKey)} onClick={() => set('accent', a)}
                  className={`h-9 w-9 rounded-full border-2 ${s.accent === a ? 'border-fg' : 'border-transparent'}`} style={{ background: portalAccents[a].light }} />
              ))}
            </div></fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">{t('p9.ps.logo')}</span>
            <span className="text-sm text-muted">{s.logoDocumentId ? t('p9.ps.logoSet') : t('p9.ps.logoNone')}</span>
            <button type="button" className="btn" onClick={() => file.current?.click()} disabled={logo.isPending}>{t('p9.ps.logoUpload')}</button>
            {s.logoDocumentId && <button type="button" className="btn" onClick={() => set('logoDocumentId', null)}>{t('p9.ps.logoRemove')}</button>}
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-hidden tabIndex={-1} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) logo.mutate(f); }} />
          </div>
          <GrantsEditor label={t('p9.ps.defaultGrants')} value={s.defaultGrants} onChange={(g) => set('defaultGrants', g)} />
        </fieldset>
        {(save.isError || logo.isError) && <p role="alert" className="text-sm text-overdue">{((save.error ?? logo.error) as Error).message}</p>}
        {save.isSuccess && <p role="status" className="text-sm text-done">{t('p9.saved')}</p>}
        {editable && <button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button>}
      </form>
      {can('clients', 'edit') && <EnableClient />}
    </div>
  );
}

function EnableClient() {
  const t = useT();
  const [c, setC] = useState<PickedClient | null>(null);
  const m = useMutation({ mutationFn: (enabled: boolean) => as(api.PUT('/portal-admin/clients/{id}/enabled', { params: { path: { id: c!.id } }, body: { enabled } })) });
  return (
    <section className="card space-y-2 p-4" aria-label={t('p9.ps.perClient')}>
      <h2 className="font-semibold">{t('p9.ps.perClient')}</h2>
      <ClientPicker label={t('p9.portal.client')} value={c} onChange={(x) => { setC(x); m.reset(); }} />
      {c && <div className="flex gap-2"><button className="btn" onClick={() => m.mutate(true)}>{t('p9.ps.enable')}</button><button className="btn" onClick={() => m.mutate(false)}>{t('p9.ps.disable')}</button></div>}
      {m.isSuccess && <p role="status" className="text-sm text-done">{t(m.variables ? 'p9.ps.enabledFor' : 'p9.ps.disabledFor', { name: c?.name ?? '' })}</p>}
      {m.isError && <p role="alert" className="text-sm text-overdue">{(m.error as Error).message}</p>}
    </section>
  );
}

/** Per-client grants: area switches + document categories/FYs ('*' = all). Controlled; validation errors shown inline. */
export function GrantsEditor({ value, onChange, label }: { value: PortalGrants; onChange(g: PortalGrants): void; label: string }) {
  const t = useT();
  const [cats, setCats] = useState(listToText(value.documents.categories));
  const [fys, setFys] = useState(listToText(value.documents.fys));
  const bad = invalidFys(fys.split(',').map((x) => x.trim()).filter(Boolean));
  return (
    <fieldset className="space-y-2 rounded border border-border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.documents.enabled} onChange={(e) => onChange(grantsReducer(value, { type: 'documents', on: e.target.checked }))} /> {t('p9.grant.documents')}</label>
      {value.documents.enabled && <div className="grid gap-2 pl-6 sm:grid-cols-2">
        <Field label={t('p9.grant.categories')} hint={t('p9.grant.allHint')}><input className="input" value={cats} onChange={(e) => { setCats(e.target.value); onChange(grantsReducer(value, { type: 'categories', text: e.target.value })); }} /></Field>
        <Field label={t('p9.grant.fys')} hint={t('p9.grant.fyHint')} error={bad.length ? t('p9.grant.badFy', { v: bad.join(', ') }) : null}>
          <input className="input" value={fys} onChange={(e) => { setFys(e.target.value); onChange(grantsReducer(value, { type: 'fys', text: e.target.value })); }} /></Field>
      </div>}
      <div className="grid gap-1 sm:grid-cols-2">{GRANT_FLAGS.map((f) => (
        <label key={f} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value[f]} onChange={(e) => onChange(grantsReducer(value, { type: 'flag', flag: f, on: e.target.checked }))} /> {t(`p9.grant.${f}` as MessageKey)}</label>
      ))}</div>
    </fieldset>
  );
}

/** Client 360 → Portal: enable, users + grants, invite, portal thread, profile change requests. */
export function ClientPortalTab({ client }: { client: Schemas['ClientDetail'] }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['portal-admin', 'users', client.id], queryFn: () => as<PortalUser[]>(api.GET('/portal-admin/users', { params: { query: { clientId: client.id } } })) });
  const enable = useMutation({ mutationFn: (enabled: boolean) => as(api.PUT('/portal-admin/clients/{id}/enabled', { params: { path: { id: client.id } }, body: { enabled } })) });
  const edit = can('clients', 'edit');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['portal-admin'] });
  return (
    <div className="space-y-3">
      {edit && <section className="card flex flex-wrap items-center gap-2 p-4" aria-label={t('p9.cp.switch')}>
        <h2 className="flex-1 font-semibold">{t('p9.cp.switch')}</h2>
        <button className="btn" onClick={() => enable.mutate(true)}>{t('p9.ps.enable')}</button>
        <button className="btn" onClick={() => enable.mutate(false)}>{t('p9.ps.disable')}</button>
        {enable.isSuccess && <span role="status" className="w-full text-sm text-done">{t(enable.variables ? 'p9.ps.enabledFor' : 'p9.ps.disabledFor', { name: client.name })}</span>}
        {enable.isError && <span role="alert" className="w-full text-sm text-overdue">{(enable.error as Error).message}</span>}
      </section>}
      <section className="card space-y-2 p-4" aria-label={t('p9.cp.users')}>
        <h2 className="font-semibold">{t('p9.cp.users')}</h2>
        {!users.data ? <p className="text-muted">{t('common.loading')}</p> : !users.data.length ? <p className="text-sm text-muted">{t('p9.cp.noUsers')}</p>
          : <ul className="space-y-3">{users.data.map((u) => <UserRow key={u.id} u={u} clientId={client.id} canEdit={edit} onChange={refresh} />)}</ul>}
        {edit && <InviteForm client={client} onDone={refresh} />}
      </section>
      {can('communication', 'view') && <Thread clientId={client.id} canReply={can('communication', 'create')} />}
      <ProfileRequests clientId={client.id} canEdit={edit} />
    </div>
  );
}

function UserRow({ u, clientId, canEdit, onChange }: { u: PortalUser; clientId: string; canEdit: boolean; onChange(): void }) {
  const t = useT();
  const acc = u.access.find((a) => a.clientId === clientId);
  const [g, setG] = useReducer(grantsReducer, acc?.grants ?? defaultPortalGrants());
  const save = useMutation({ mutationFn: (b: { grants?: PortalGrants; revoked?: boolean }) => as(api.PATCH('/portal-admin/access/{id}', { params: { path: { id: acc!.id } }, body: body(b) })), onSuccess: onChange });
  const status = useMutation({ mutationFn: (s: 'active' | 'disabled') => as(api.PATCH('/portal-admin/users/{id}', { params: { path: { id: u.id } }, body: { status: s } })), onSuccess: onChange });
  if (!acc) return null;
  return (
    <li className="space-y-2 rounded border border-border p-3" aria-label={u.name}>
      <div className="flex flex-wrap items-baseline gap-2"><span className="flex-1 font-medium">{u.name} <span className="text-sm font-normal text-muted">{[u.email, u.phone].filter(Boolean).join(' · ')}</span></span>
        <span className="text-xs">{t(`p9.cp.st.${u.status}` as MessageKey)}{u.lastLoginAt ? ` · ${t('p9.cp.lastLogin', { at: formatDateTime(u.lastLoginAt) })}` : ''}</span>
        {acc.revokedAt && <span className="text-xs text-overdue">{t('p9.cp.revoked')}</span>}</div>
      {canEdit && !acc.revokedAt && <>
        <GrantsEditor label={t('p9.cp.grants')} value={g} onChange={(x) => setG({ type: 'reset', grants: x })} />
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={sameGrants(g, acc.grants) || save.isPending} onClick={() => save.mutate({ grants: g })}>{t('p9.cp.saveGrants')}</button>
          <button className="btn" onClick={() => confirm(t('p9.cp.revokeConfirm', { name: u.name })) && save.mutate({ revoked: true })}>{t('p9.cp.revoke')}</button>
          <button className="btn" onClick={() => status.mutate(u.status === 'disabled' ? 'active' : 'disabled')}>{u.status === 'disabled' ? t('p9.cp.enableUser') : t('p9.cp.disableUser')}</button>
        </div>
      </>}
      {canEdit && acc.revokedAt && <button className="btn" onClick={() => save.mutate({ revoked: false })}>{t('p9.cp.restore')}</button>}
      {(save.isError || status.isError) && <p role="alert" className="text-sm text-overdue">{((save.error ?? status.error) as Error).message}</p>}
    </li>
  );
}

function InviteForm({ client, onDone }: { client: Schemas['ClientDetail']; onDone(): void }) {
  const t = useT();
  const contacts = client.contacts.filter((c) => c.email || c.phone);
  const [contactId, setContactId] = useState(contacts[0]?.id ?? '');
  const [channel, setChannel] = useState<'email' | 'whatsapp' | 'sms'>('email');
  const settings = useQuery({ queryKey: ['portal-admin', 'settings'], queryFn: () => as<PortalSettings>(api.GET('/portal-admin/settings')), retry: false });
  const [g, setG] = useState<PortalGrants | null>(null);
  const grants = g ?? settings.data?.defaultGrants ?? null;
  const [existing, setExisting] = useState<string | null>(null);
  const inv = useMutation({
    mutationFn: (linkExisting: boolean) => asFull<{ portalUserId: string; invite: { status?: string } | null }>(api.POST('/portal-admin/invites', { body: body({ clientId: client.id, contactId, channel, send: true, ...(grants ? { grants } : {}), ...(linkExisting ? { linkExisting: true } : {}) }) })),
    onSuccess: () => { setExisting(null); onDone(); },
    onError: (e) => {
      const b = (e as { body?: { code?: string; match?: { email: string | null; phone: string | null } } }).body;
      if (b?.code === 'existing_portal_user') setExisting([b.match?.email, b.match?.phone].filter(Boolean).join(' / ') || '—');
    },
  });
  if (!contacts.length) return <p className="text-sm text-muted">{t('p9.cp.noContacts')}</p>;
  return (
    <form className="space-y-2 border-t border-border pt-3" aria-label={t('p9.cp.invite')} onSubmit={(e) => { e.preventDefault(); if (contactId) inv.mutate(false); }}>
      <h3 className="font-medium">{t('p9.cp.invite')}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={t('p9.cp.contact')}><select className="input" value={contactId} onChange={(e) => { setContactId(e.target.value); setExisting(null); }}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.email ?? c.phone})</option>)}</select></Field>
        <Field label={t('p9.send.channel')}><select className="input" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>{(['email', 'whatsapp', 'sms'] as const).map((c) => <option key={c} value={c}>{t(`p9.ch.${c}` as MessageKey)}</option>)}</select></Field>
      </div>
      {grants && <GrantsEditor label={t('p9.cp.grants')} value={grants} onChange={setG} />}
      {inv.isSuccess && <p role="status" className="text-sm text-done">{t('p9.cp.invited', { status: inv.data?.invite?.status ?? 'ok' })}</p>}
      {existing ? <div role="alert" className="space-y-1 text-sm"><p>{t('p9.cp.existing', { match: existing })}</p>
        <button type="button" className="btn" disabled={inv.isPending} onClick={() => inv.mutate(true)}>{t('p9.cp.linkExisting')}</button></div>
        : inv.isError && <p role="alert" className="text-sm text-overdue">{(inv.error as Error).message}</p>}
      <button className="btn btn-primary" disabled={!contactId || inv.isPending}>{t('p9.cp.sendInvite')}</button>
    </form>
  );
}

function Thread({ clientId, canReply }: { clientId: string; canReply: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portal-admin', 'thread', clientId], queryFn: () => as<ThreadMsg[]>(api.GET('/portal-admin/clients/{id}/messages', { params: { path: { id: clientId } } })), refetchInterval: 30_000 });
  const [text, setText] = useState('');
  const reply = useMutation({ mutationFn: () => as(api.POST('/portal-admin/clients/{id}/messages', { params: { path: { id: clientId } }, body: { body: text.trim() } })),
    onSuccess: () => { setText(''); void qc.invalidateQueries({ queryKey: ['portal-admin', 'thread', clientId] }); } });
  return (
    <section className="card space-y-2 p-4" aria-label={t('p9.cp.thread')}>
      <h2 className="font-semibold">{t('p9.cp.thread')}</h2>
      <ul className="max-h-80 space-y-2 overflow-auto">{(q.data ?? []).filter((m) => m.direction !== 'internal').map((m) => (
        <li key={m.id} className={`max-w-[85%] rounded p-2 text-sm ${m.direction === 'out' ? 'ml-auto bg-primary text-primary-fg' : 'bg-surface-alt'}`}>
          <div className="whitespace-pre-wrap">{m.body}</div><div className="text-xs opacity-75">{t(m.direction === 'in' ? 'p9.cp.fromClient' : 'p9.cp.fromFirm')} · {formatDateTime(m.at)}</div></li>))}
        {q.data && !q.data.length && <li className="text-sm text-muted">{t('p9.msg.empty')}</li>}</ul>
      {canReply && <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) reply.mutate(); }}>
        <input className="input flex-1" aria-label={t('p9.cp.reply')} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
        <button className="btn btn-primary" disabled={!text.trim() || reply.isPending}>{t('p9.msg.send')}</button></form>}
      {reply.isError && <p role="alert" className="text-sm text-overdue">{(reply.error as Error).message}</p>}
    </section>
  );
}

function ProfileRequests({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portal-admin', 'profile-requests'], queryFn: () => as<ProfileReq[]>(api.GET('/portal-admin/profile-requests', { params: { query: { status: 'pending' } } })) });
  const decide = useMutation({
    mutationFn: (b: { id: string; approve: boolean; reason?: string | null }) => as(api.POST('/portal-admin/profile-requests/{id}/decide', { params: { path: { id: b.id } }, body: { approve: b.approve, reason: b.reason ?? null } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portal-admin', 'profile-requests'] }),
  });
  const rows = (q.data ?? []).filter((r) => r.clientId === clientId);
  return (
    <section className="card space-y-2 p-4" aria-label={t('p9.cp.profileReqs')}>
      <h2 className="font-semibold">{t('p9.cp.profileReqs')}</h2>
      {!rows.length ? <p className="text-sm text-muted">{t('p9.prof.noRequests')}</p> : <ul className="space-y-2">{rows.map((r) => (
        <li key={r.id} className="rounded border border-border p-2 text-sm">
          <div className="text-xs text-muted">{r.requestedBy} · {formatDate(r.createdAt)}</div>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-2">{Object.entries(r.changes).map(([k, v]) => <Fragment key={k}><dt className="text-muted">{t(`p9.prof.f.${k}` as MessageKey)}</dt><dd>{v ?? '—'}</dd></Fragment>)}</dl>
          {canEdit && <div className="mt-1 flex gap-2">
            <button className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })}>{t('p9.cp.approve')}</button>
            <button className="btn" disabled={decide.isPending} onClick={() => { const reason = prompt(t('p9.cp.rejectReason')); if (reason !== null) decide.mutate({ id: r.id, approve: false, reason: reason || null }); }}>{t('p9.cp.reject')}</button>
          </div>}
        </li>))}</ul>}
      {decide.isError && <p role="alert" className="text-sm text-overdue">{(decide.error as Error).message}</p>}
    </section>
  );
}
