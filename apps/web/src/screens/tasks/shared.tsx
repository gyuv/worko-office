import { useQuery } from '@tanstack/react-query';
import { en, type MessageKey } from '@worko/i18n';
import { TASK_PRIORITIES, TASK_STATUSES } from '@worko/domain';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { api, unwrap } from '../../lib/session';

/** Team members for people pickers. Users without users:view still see "me" and ids they can resolve. */
export function useUsers() {
  const can = useCan();
  const q = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')), retry: false, enabled: can('users', 'view'), staleTime: 60_000 });
  const me = useMe().data;
  const list = (q.data ?? []).filter((u) => u.status !== 'disabled').map((u) => ({ id: u.id, name: u.name }));
  const users = me && !list.some((u) => u.id === me.id) ? [{ id: me.id, name: me.name }, ...list] : list;
  const name = (id: string | null | undefined) => (id ? users.find((u) => u.id === id)?.name ?? '…' : '—');
  return { users, name };
}

export const useServiceTypes = (all = false) =>
  useQuery({ queryKey: ['service-types', all], queryFn: () => unwrap(api.GET('/service-types', { params: { query: all ? { all: 'true' } : {} } })), staleTime: 60_000 });

/** Human message for a server rule error (`code` from a 400), falling back to the server message. */
export function useRuleMessage() {
  const t = useT();
  return (e: unknown) => {
    const code = (e as { code?: string } | null)?.code?.split(':')[0];
    const key = `tasks.rule.${code}` as MessageKey;
    if (code && key in en) return t(key);
    return (e as Error | null)?.message || t('common.error');
  };
}

export function useStatusLabel() {
  const t = useT();
  return (s: string) => ((TASK_STATUSES as readonly string[]).includes(s) ? t(`tasks.status.${s}` as MessageKey) : s);
}
export function usePriorityLabel() {
  const t = useT();
  return (p: string) => ((TASK_PRIORITIES as readonly string[]).includes(p) ? t(`tasks.priority.${p}` as MessageKey) : p);
}

export function PersonSelect({ label, value, onChange, allowNone = true }: { label: string; value: string | null; onChange(v: string | null): void; allowNone?: boolean }) {
  const t = useT();
  const { users } = useUsers();
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        {allowNone && <option value="">{t('tasks.nobody')}</option>}
        {value && !users.some((u) => u.id === value) && <option value={value}>…</option>}
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </label>
  );
}
