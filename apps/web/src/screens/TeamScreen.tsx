import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACTIONS, MODULES, SCOPES, type Action, type Module, type Scope } from '@worko/domain';
import { Lock, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field, Tabs } from '../components/Dialog';
import { initials } from '../components/Shell';
import { toast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { useCan, useMe } from '../lib/me';
import { api, unwrap } from '../lib/session';

type Grant = { module: Module; action: Action; scope: Scope; clientGroupIds?: string[] };
type Role = { id: string; key: string; name: string; system: boolean; grants: Grant[]; hiddenFields: string[] };
type User = { id: string; name: string; email: string; phone?: string | null; status: string; roles: string[]; totpEnabled?: boolean };

const err = (e: unknown) => (e as { message?: string })?.message ?? String(e);
async function call<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const r = await p;
  if (r.error || !r.response.ok) { const b = r.error as { message?: string | string[] } | undefined; throw new Error(Array.isArray(b?.message) ? b!.message.join(', ') : b?.message ?? `HTTP ${r.response.status}`); }
  return r.data as T;
}

/** Firm admin: members (add, roles, enable/disable) and roles & permissions (module × action → reach). */
export function TeamScreen() {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = useState<'members' | 'roles'>('members');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[26px] font-bold">{t('nav.team')}</h1>
        <p className="text-muted">{t('team.subtitle')}</p>
      </div>
      <Tabs label={t('nav.team')} value={tab} onChange={(k) => setTab(k as "members" | "roles")} tabs={[["members", t("team.members")], ["roles", t("team.roles")]]} />
      <div key={tab} className="page">{tab === 'members' ? <Members canEdit={can('users', 'edit')} canCreate={can('users', 'create')} /> : <Roles canEdit={can('users', 'edit')} />}</div>
    </div>
  );
}

function Members({ canEdit, canCreate }: { canEdit: boolean; canCreate: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe().data;
  const can = useCan();
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')) as Promise<User[]> });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => unwrap(api.GET('/roles')) as Promise<Role[]> });
  const sub = useQuery({ queryKey: ['subscription'], enabled: can('settings', 'view'), queryFn: async () => (await unwrap(api.GET('/subscription'))) as unknown as { usage?: { seatsUsed: number; seatLimit: number | null } } });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [q, setQ] = useState('');
  const roleName = (k: string) => roles.data?.find((r) => r.key === k)?.name ?? k;
  const status = useMutation({
    mutationFn: (x: { id: string; status: 'active' | 'disabled' }) => call(api.PATCH('/users/{id}', { params: { path: { id: x.id } }, body: { status: x.status } })),
    onSuccess: (_r, x) => { toast({ text: x.status === 'active' ? t('team.enabled') : t('team.disabled'), tone: 'ok' }); void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['subscription'] }); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const u = sub.data?.usage;
  const list = (users.data ?? []).filter((x) => !q || `${x.name} ${x.email}`.toLowerCase().includes(q.toLowerCase()));
  const pct = u?.seatLimit ? Math.min(100, Math.round((u.seatsUsed / u.seatLimit) * 100)) : 0;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input type="search" className="input max-w-xs" placeholder={t('team.search')} aria-label={t('team.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        {u && (
          <div className="card flex min-w-56 items-center gap-3 px-4 py-2" aria-label={t('team.seats')}>
            <div className="flex-1">
              <div className="text-xs text-muted">{t('team.seats')}</div>
              <div className="font-semibold">{u.seatLimit ? t('team.seatsOf', { used: u.seatsUsed, limit: u.seatLimit }) : t('team.seatsUnlimited', { used: u.seatsUsed })}</div>
              {u.seatLimit && <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-alt"><div className="h-full rounded-full bg-primary transition-all duration-700" style={{ width: `${pct}%` }} /></div>}
            </div>
          </div>
        )}
        {canCreate && <button className="btn btn-primary ml-auto" onClick={() => setAdding(true)}><UserPlus size={15} aria-hidden /> {t('team.add')}</button>}
      </div>
      <div className="card overflow-auto">
        <table className="table w-full">
          <thead><tr><th>{t('team.member')}</th><th>{t('home.roles')}</th><th>{t('security.twoFactor')}</th><th>{t('team.status')}</th>{canEdit && <th className="text-right">{t('team.actions')}</th>}</tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id}>
                <td>
                  <div className="flex items-center gap-3">
                    <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-xs font-bold text-white">{initials(x.name)}</span>
                    <span className="min-w-0"><span className="block font-semibold">{x.name}{x.id === me?.id ? ` (${t('team.you')})` : ''}</span><span className="block text-sm text-muted">{x.email}</span></span>
                  </div>
                </td>
                <td><div className="flex flex-wrap gap-1">{x.roles.map((r) => <span key={r} className="pill bg-primary-soft text-primary">{roleName(r)}</span>)}</div></td>
                <td>{x.totpEnabled ? <ShieldCheck size={16} className="text-done" aria-label={t('security.twoFactorOn')} /> : <span className="text-muted">{t('security.twoFactorOff')}</span>}</td>
                <td><span className={`pill ${x.status === 'active' ? 'bg-primary-soft text-primary' : 'bg-surface-alt text-muted'}`}>{x.status === 'active' ? t('team.active') : t('team.inactive')}</span></td>
                {canEdit && (
                  <td className="text-right">
                    <div className="inline-flex gap-1.5">
                      <button className="btn py-1" onClick={() => setEditing(x)}>{t('team.edit')}</button>
                      {x.id !== me?.id && <button className={`btn py-1 ${x.status === 'active' ? 'btn-danger' : ''}`} disabled={status.isPending}
                        onClick={() => status.mutate({ id: x.id, status: x.status === 'active' ? 'disabled' : 'active' })}>{x.status === 'active' ? t('team.disable') : t('team.enable')}</button>}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {users.data && list.length === 0 && <p className="p-6 text-center text-muted">{t('team.none')}</p>}
      </div>
      {adding && <MemberDialog roles={roles.data ?? []} onClose={() => setAdding(false)} />}
      {editing && <MemberDialog roles={roles.data ?? []} user={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function MemberDialog({ roles, user, onClose }: { roles: Role[]; user?: User; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(user?.name ?? ''); const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? ''); const [password, setPassword] = useState('');
  const [keys, setKeys] = useState<string[]>(user?.roles ?? []);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const ph = phone.trim() ? phone.replace(/[\s-]/g, '') : undefined;
      if (user) return call(api.PATCH('/users/{id}', { params: { path: { id: user.id } }, body: { name: name.trim(), phone: ph ?? null, roleKeys: keys } }));
      return call(api.POST('/users', { body: { name: name.trim(), email: email.trim(), phone: ph, password, roleKeys: keys } }));
    },
    onSuccess: () => { toast({ text: user ? t('team.saved') : t('team.added', { name }), tone: 'ok' }); void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['subscription'] }); onClose(); },
    onError: (e) => setError(err(e)),
  });
  return (
    <Dialog title={user ? t('team.editTitle', { name: user.name }) : t('team.add')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setError(null); if (!keys.length) { setError(t('team.pickRole')); return; } save.mutate(); }}>
        <Field label={t('team.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        {!user && <Field label={t('auth.email')}><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>}
        <Field label={t('team.phone')}><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919800000000" /></Field>
        {!user && <Field label={t('team.password')}><input className="input" type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>}
        <fieldset>
          <legend className="label">{t('home.roles')}</legend>
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => {
              const on = keys.includes(r.key);
              return <button type="button" key={r.key} aria-pressed={on} onClick={() => setKeys(on ? keys.filter((k) => k !== r.key) : [...keys, r.key])}
                className={`btn ${on ? 'btn-primary' : ''}`}>{r.name}</button>;
            })}
          </div>
        </fieldset>
        {error && <p role="alert" className="text-overdue">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={save.isPending}>{user ? t('team.save') : t('team.add')}</button></div>
      </form>
    </Dialog>
  );
}

const REACH: Scope[] = ['none', 'own', 'team', 'branch', 'all'];

function Roles({ canEdit }: { canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => unwrap(api.GET('/roles')) as Promise<Role[]> });
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Grant[] | null>(null);
  const [creating, setCreating] = useState(false);
  const role = roles.data?.find((r) => r.id === sel) ?? roles.data?.[0];
  const grants = draft ?? role?.grants ?? [];
  const locked = !canEdit || role?.key === 'partner';
  const scopeOf = (m: Module, a: Action): Scope => grants.find((g) => g.module === m && g.action === a)?.scope ?? 'none';
  const setScope = (m: Module, a: Action, s: Scope) => {
    const rest = grants.filter((g) => !(g.module === m && g.action === a));
    setDraft(s === 'none' ? rest : [...rest, { module: m, action: a, scope: s }]);
  };
  const save = useMutation({
    mutationFn: () => call(api.PATCH('/roles/{id}', { params: { path: { id: role!.id } }, body: { grants: grants as never } })),
    onSuccess: () => { toast({ text: t('team.roleSaved'), tone: 'ok' }); setDraft(null); void qc.invalidateQueries({ queryKey: ['roles'] }); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const del = useMutation({
    mutationFn: () => call(api.DELETE('/roles/{id}', { params: { path: { id: role!.id } } })),
    onSuccess: () => { toast({ text: t('team.roleDeleted'), tone: 'ok' }); setSel(null); setDraft(null); void qc.invalidateQueries({ queryKey: ['roles'] }); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const count = grants.filter((g) => g.scope !== "none").length;
  if (!roles.data) return <div className="skeleton h-64" />;
  return (
    <section className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <div className="card h-fit p-2">
        <ul className="space-y-0.5">
          {roles.data.map((r) => (
            <li key={r.id}>
              <button className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors ${r.id === role?.id ? 'bg-primary-soft font-semibold' : 'hover:bg-surface-alt'}`} onClick={() => { setSel(r.id); setDraft(null); }}>
                <span className="flex-1">{r.name}</span>{r.system && <span className="text-xs text-muted">{t('team.builtIn')}</span>}{r.key === 'partner' && <Lock size={13} aria-hidden className="text-muted" />}
              </button>
            </li>
          ))}
        </ul>
        {canEdit && <button className="btn mt-2 w-full justify-center" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t('team.newRole')}</button>}
      </div>
      {role && (
        <div className="card min-w-0 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{role.name}</h2><span className="pill bg-surface-alt text-muted">{t('team.grantCount', { n: count })}</span>
            {role.key === 'partner' && <span className="text-sm text-muted">{t('team.partnerLocked')}</span>}
            <div className="ml-auto flex gap-2">
              {!role.system && canEdit && <button className="btn btn-danger" onClick={() => del.mutate()} disabled={del.isPending}><Trash2 size={14} aria-hidden /> {t('team.deleteRole')}</button>}
              {!locked && draft && <><button className="btn" onClick={() => setDraft(null)}>{t('common.cancel')}</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{t('team.saveRole')}</button></>}
            </div>
          </div>
          <p className="mb-3 text-sm text-muted">{t('team.reachHint')}</p>
          <div className="overflow-auto">
            <table className="table w-full min-w-[900px] text-sm">
              <thead><tr><th>{t('team.module')}</th>{ACTIONS.map((a) => <th key={a}>{t(`team.action.${a}` as never)}</th>)}</tr></thead>
              <tbody>
                {MODULES.map((m) => (
                  <tr key={m}>
                    <td className="font-medium">{t(`team.mod.${m}` as never)}</td>
                    {ACTIONS.map((a) => {
                      const s = scopeOf(m, a);
                      return (
                        <td key={a}>
                          <select aria-label={`${m} ${a}`} disabled={locked} value={s} onChange={(e) => setScope(m, a, e.target.value as Scope)}
                            className={`rounded-lg border border-border px-1.5 py-1 text-xs ${s === 'none' ? 'bg-surface text-muted' : 'bg-primary-soft font-semibold text-fg'}`}>
                            {(SCOPES as readonly Scope[]).filter((x) => REACH.includes(x) || x === s).map((x) => <option key={x} value={x}>{t(`team.scope.${x}` as never)}</option>)}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {creating && <NewRoleDialog roles={roles.data} onClose={() => setCreating(false)} onCreated={(id) => { setSel(id); setCreating(false); }} />}
    </section>
  );
}

function NewRoleDialog({ roles, onClose, onCreated }: { roles: Role[]; onClose(): void; onCreated(id: string): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(''); const [from, setFrom] = useState(roles.find((r) => r.key === 'senior')?.key ?? roles[0]?.key ?? '');
  const [error, setError] = useState<string | null>(null);
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'r_$1').slice(0, 30) || 'role';
  const create = useMutation({
    mutationFn: () => call<{ id?: string }>(api.POST("/roles", { body: { key, name: name.trim(), grants: (roles.find((r) => r.key === from)?.grants ?? []) as never } })),
    onSuccess: (r) => { toast({ text: t('team.roleCreated', { name }), tone: 'ok' }); void qc.invalidateQueries({ queryKey: ['roles'] }); onCreated(r.id ?? ''); },
    onError: (e) => setError(err(e)),
  });
  return (
    <Dialog title={t('team.newRole')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setError(null); create.mutate(); }}>
        <Field label={t('team.roleName')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder={t('team.roleNameHint')} /></Field>
        <Field label={t('team.copyFrom')}><select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></Field>
        {error && <p role="alert" className="text-overdue">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={create.isPending}>{t('team.create')}</button></div>
      </form>
    </Dialog>
  );
}
