import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@worko/i18n';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';

/** IST date → end-of-day timestamp, so a to-do "due 28 Oct" is due through that IST day. */
export const dueAtFromDate = (ymd: string) => `${ymd}T23:59:00+05:30`;
const istDate = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

export function TodosScreen() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const today = todayIst();
  const [showDone, setShowDone] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [tpl, setTpl] = useState('');
  const [base, setBase] = useState(today);
  const list = useQuery({ queryKey: ['todos', showDone], queryFn: () => unwrap(api.GET('/todos', { params: { query: showDone ? {} : { done: 'false' } } })) });
  const templates = useQuery({ queryKey: ['todo-templates'], queryFn: () => unwrap(api.GET('/todo-templates')), enabled: can('tasks', 'view') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['todos'] });
  const add = useMutation({
    mutationFn: () => unwrap(api.POST('/todos', { body: { title: title.trim(), due_at: due ? dueAtFromDate(due) : null } })),
    onSuccess: () => { setTitle(''); setDue(''); refresh(); },
  });
  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => unwrap(api.PATCH('/todos/{id}', { params: { path: { id } }, body: { done, done_at: done ? new Date().toISOString() : null } })),
    onSettled: refresh,
  });
  const del = useMutation({ mutationFn: (id: string) => unwrap(api.DELETE('/todos/{id}', { params: { path: { id } } })), onSettled: refresh });
  const apply = useMutation({
    mutationFn: () => unwrap(api.POST('/todo-templates/{id}/apply', { params: { path: { id: tpl } }, body: { baseDate: base } })),
    onSuccess: refresh,
  });
  const items = [...(list.data ?? [])].sort((a, b) => Number(a.done) - Number(b.done) || (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9'));

  return (
    <div className="max-w-3xl space-y-3">
      <h1 className="text-xl font-semibold">{t('nav.todos')}</h1>
      <form className="card flex flex-wrap items-end gap-2 p-3" onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(); }}>
        <label className="min-w-48 flex-1"><span className="label">{t('todos.new')}</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label><span className="label">{t('todos.due')}</span><input type="date" className="input w-40" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={add.isPending}><Plus size={14} aria-hidden /> {t('common.add')}</button>
      </form>
      {(templates.data?.length ?? 0) > 0 && (
        <form className="card flex flex-wrap items-end gap-2 p-3" onSubmit={(e) => { e.preventDefault(); if (tpl) apply.mutate(); }}>
          <label><span className="label">{t('todos.template')}</span>
            <select className="input w-56" value={tpl} onChange={(e) => setTpl(e.target.value)}>
              <option value="">—</option>
              {templates.data!.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.items.length})</option>)}
            </select></label>
          <label><span className="label">{t('todos.baseDate')}</span><input type="date" className="input w-40" value={base} onChange={(e) => setBase(e.target.value)} /></label>
          <button className="btn" disabled={!tpl || apply.isPending}>{t('todos.apply')}</button>
          {apply.data && <span role="status" className="pb-2 text-sm text-done">{t('todos.applied', { count: apply.data.ids.length })}</span>}
        </form>
      )}
      <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> {t('todos.showDone')}</label>
      {list.data && !items.length ? <p className="card p-6 text-muted">{t('todos.empty')}</p> : (
        <ul className="card divide-y divide-border">
          {items.map((x) => {
            const d = x.dueAt ? istDate(x.dueAt) : null;
            const late = !x.done && d && d < today;
            return (
              <li key={x.id} className="flex items-center gap-2 px-3 py-2">
                <input type="checkbox" aria-label={t('todos.markDone', { title: x.title })} checked={x.done} onChange={(e) => toggle.mutate({ id: x.id, done: e.target.checked })} />
                <span className={`flex-1 ${x.done ? 'text-muted line-through' : ''}`}>{x.title}{x.taskId && <span className="ml-2 text-xs text-muted">{t('todos.linked')}</span>}</span>
                {d && <span className={`text-xs ${late ? 'text-overdue' : 'text-muted'}`}>{formatDate(d)}</span>}
                <button className="rounded p-1 text-muted hover:text-overdue" aria-label={t('todos.delete', { title: x.title })} onClick={() => del.mutate(x.id)}><Trash2 size={14} /></button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
