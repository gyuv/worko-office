import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACTION_TYPES, COMM_CHANNELS, CONTEXT_FIELDS, isScanEvent, PERSON_REFS, TASK_PRIORITIES, TASK_STATUSES,
  type ActionType, type AutomationEvent, type RuleDefinition, type RuleScope, type Schedule,
} from '@worko/domain';
import { formatDateTime } from '@worko/i18n';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { parseRupees } from '../billing/logic';
import { useUsers } from '../leads/api';
import { asFull, body, useAutoError, useAutoLabel, type DryRun, type Rule, type Version } from './api';
import { DryRunView } from './DryRunView';
import {
  actionsFor, EVENT_TRIGGERS, fieldsFor, fieldType, fromCondition, isList, isPaiseField, leafErrors, lineDiff, needsValue, nid, opsFor, pretty, scheduleText, toCondition,
  updateNode, validateDefinition, type DefIssues, type GroupNode, type LeafNode, type Node,
} from './logic';

type Act = Record<string, unknown> & { type: ActionType };
const DEFAULT_ACTION: Record<ActionType, Act> = {
  create_task: { type: 'create_task', when: 'always', title: '', assignee: 'owner', priority: 'normal', checklist: [] },
  assign_task: { type: 'assign_task', when: 'always', to: 'task_manager' },
  add_checklist_item: { type: 'add_checklist_item', when: 'always', label: '', required: false },
  set_task_status: { type: 'set_task_status', when: 'always', status: 'pending_client' },
  send_message: { type: 'send_message', when: 'always', channel: 'email', subject: '', body: '' },
  create_pbc_request: { type: 'create_pbc_request', when: 'always', items: [{ title: '' }] },
  notify: { type: 'notify', when: 'always', to: ['owner'], title: '', priority: 'normal' },
  add_timeline_note: { type: 'add_timeline_note', when: 'always', body: '' },
  create_invoice_draft: { type: 'create_invoice_draft', when: 'always', description: '', ratePaise: 0, linkTask: true },
  request_esign: { type: 'request_esign', when: 'always', title: '' },
  ai_draft_message: { type: 'ai_draft_message', when: 'always', channel: 'email', instruction: '' },
  ai_classify_upload: { type: 'ai_classify_upload', when: 'always' },
};
/** Drop empty optional strings so the schema sees "absent", not "too short". */
function clean(a: Act): Act {
  const o: Act = { ...a };
  for (const k of ['description', 'subject', 'body', 'pendingIssue', 'templateId', 'sac']) if (o[k] === '') delete o[k];
  if (o.dueInDays === '' || o.dueInDays === undefined || Number.isNaN(o.dueInDays)) delete o.dueInDays;
  if (o.gstRate === '' || o.gstRate === undefined || Number.isNaN(o.gstRate)) delete o.gstRate;
  return o;
}

export type Draft = { name: string; description: string; scope: RuleScope; kind: 'event' | 'schedule'; event: AutomationEvent; schedule: Schedule; root: GroupNode; actions: Act[];
  ladder: RuleDefinition['ladder'] | null; limits: RuleDefinition['limits'] };
export function draftFrom(r?: Rule): Draft {
  const d = r?.definition;
  return {
    name: r?.name ?? '', description: r?.description ?? '', scope: r?.scope ?? 'firm',
    kind: d?.trigger.kind ?? 'event', event: d?.trigger.kind === 'event' ? d.trigger.event : 'task.created',
    schedule: d?.trigger.kind === 'schedule' ? d.trigger.schedule : { freq: 'daily', at: '09:00' },
    root: fromCondition(d?.conditions), actions: (d?.actions as Act[] | undefined) ?? [], ladder: d?.ladder ?? null,
    limits: d?.limits ?? { maxActionsPerRun: 10, maxActionsPerDay: 200, monthlyCostCapPaise: 50_000, pauseAfterFailures: 3 },
  };
}
export function definitionOf(d: Draft): unknown {
  return {
    trigger: d.kind === 'event' ? { kind: 'event', event: d.event } : { kind: 'schedule', schedule: d.schedule },
    conditions: toCondition(d.root), actions: d.actions.map(clean), ...(d.ladder && isScanEvent(d.event) && d.kind === 'event' ? { ladder: d.ladder } : {}), limits: d.limits,
  };
}

/** Rule builder: trigger → conditions → actions, validated with the domain zod schemas; dry-run; save = new version. */
export function RuleBuilder({ rule }: { rule?: Rule }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const err = useAutoError();
  const [d, setD] = useState<Draft>(() => draftFrom(rule));
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const ev: AutomationEvent = d.kind === 'event' ? d.event : 'schedule';
  const def = definitionOf(d);
  const leafErr = leafErrors(d.root, ev);
  const v = validateDefinition(def, d.scope);
  const issues: DefIssues = v.ok ? { form: [], actions: {}, trigger: [] } : v.issues;
  const hasLeafErr = Object.keys(leafErr).length > 0;
  const valid = v.ok && !hasLeafErr && !!d.name.trim();
  const save = useMutation({
    mutationFn: () => rule
      ? asFull<Rule>(api.PATCH('/automation/rules/{id}', { params: { path: { id: rule.id } }, body: body({ name: d.name.trim(), description: d.description.trim() || null, definition: def, ...(note.trim() ? { note: note.trim() } : {}) }) }))
      : asFull<Rule>(api.POST('/automation/rules', { body: body({ name: d.name.trim(), description: d.description.trim() || null, scope: d.scope, definition: def, enabled: false }) })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['automation'] }); toast({ text: t('p10.rb.saved', { v: r.version }), tone: 'ok' }, 3000); go(`automation/rules/${r.id}`); setNote(''); },
    onError: (e) => setServerErr(err(e)),
  });
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const manage = rule ? can('automation', 'edit') : can('automation', 'create');
  const offered = actionsFor(ev, d.scope, ACTION_TYPES);
  return (
    <div className="space-y-4">
      <a href="#/automation/rules" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('p10.tab.rules')}</a>
      <h1 className="text-xl font-semibold">{rule ? t('p10.rb.edit', { name: rule.name, v: rule.version }) : t('p10.rb.new')}</h1>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setTried(true); setServerErr(null); if (valid && manage) save.mutate(); }}>
        <section className="card grid gap-3 p-3 sm:grid-cols-3">
          <Field label={t('p10.rb.name')} error={tried && !d.name.trim() ? t('p10.v.required') : null}><input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label={t('p10.rb.scope')} hint={d.scope === 'personal' ? t('p10.rb.personalHint') : t('p10.rb.firmHint')}>
            <select className="input" value={d.scope} disabled={!!rule} onChange={(e) => set({ scope: e.target.value as RuleScope })}>
              <option value="firm">{t('p10.scope.firm')}</option><option value="personal">{t('p10.scope.personal')}</option></select></Field>
          <Field label={t('p10.rb.description')}><input className="input" value={d.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        </section>
        <TriggerPicker d={d} set={set} errors={tried ? issues.trigger : []} />
        <section className="card space-y-2 p-3" aria-label={t('p10.rb.conditions')}>
          <h2 className="font-semibold">{t('p10.rb.conditions')}</h2>
          <p className="text-xs text-muted">{t('p10.rb.conditionsHint')}</p>
          <GroupEditor g={d.root} root ev={ev} errors={leafErr} onChange={(root) => set({ root })} />
        </section>
        <section className="card space-y-2 p-3" aria-label={t('p10.rb.actions')}>
          <h2 className="font-semibold">{t('p10.rb.actions')}</h2>
          {d.actions.map((a, i) => (
            <ActionEditor key={i} a={a} i={i} scan={d.kind === 'event' && isScanEvent(d.event)} errors={tried ? issues.actions[i] ?? [] : []}
              onChange={(x) => set({ actions: d.actions.map((y, j) => (j === i ? x : y)) })} onRemove={() => set({ actions: d.actions.filter((_, j) => j !== i) })} />
          ))}
          <AddAction offered={offered} onAdd={(type) => set({ actions: [...d.actions, { ...DEFAULT_ACTION[type] }] })} />
        </section>
        {d.kind === 'event' && isScanEvent(d.event) && <LadderEditor d={d} set={set} />}
        <LimitsEditor d={d} set={set} />
        {tried && (issues.form.length > 0 || hasLeafErr) && <div role="alert" className="rounded border border-overdue p-2 text-sm text-overdue" data-testid="rule-errors">
          <p>{t('p10.rb.fix')}</p><ul className="list-disc pl-5">{issues.form.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        {serverErr && <p role="alert" className="text-sm text-overdue">{serverErr}</p>}
        {manage && <div className="flex flex-wrap items-end justify-end gap-2">
          {rule && <Field label={t('p10.rb.note')}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
          <button className="btn btn-primary" disabled={save.isPending}>{rule ? t('p10.rb.saveVersion') : t('p10.rb.create')}</button>
        </div>}
      </form>
      <DryRunPanel rule={rule} scope={d.scope} def={def} ok={valid || (v.ok && !hasLeafErr)} />
      {rule && <Versions rule={rule} />}
    </div>
  );
}

function TriggerPicker({ d, set, errors }: { d: Draft; set(p: Partial<Draft>): void; errors: string[] }) {
  const t = useT();
  const label = useAutoLabel();
  const s = d.schedule;
  return (
    <section className="card space-y-2 p-3" aria-label={t('p10.rb.trigger')}>
      <h2 className="font-semibold">{t('p10.rb.trigger')}</h2>
      <div role="radiogroup" aria-label={t('p10.rb.trigger')} className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={d.kind === 'event'} onChange={() => set({ kind: 'event' })} /> {t('p10.rb.onEvent')}</label>
        <label className="flex items-center gap-2"><input type="radio" checked={d.kind === 'schedule'} onChange={() => set({ kind: 'schedule' })} /> {t('p10.rb.onSchedule')}</label>
      </div>
      {d.kind === 'event' ? <Field label={t('p10.rb.event')} hint={isScanEvent(d.event) ? t('p10.rb.scanHint') : t('p10.rb.changeHint')}>
        <select className="input" value={d.event} onChange={(e) => set({ event: e.target.value as AutomationEvent })}>
          {EVENT_TRIGGERS.map((x) => <option key={x} value={x}>{label('event', x)}</option>)}</select></Field>
        : <div className="grid gap-2 sm:grid-cols-4">
          <Field label={t('p10.rb.freq')}><select className="input" value={s.freq} onChange={(e) => {
            const freq = e.target.value as Schedule['freq'];
            set({ schedule: { freq, at: s.at, ...(freq === 'weekly' ? { weekday: s.weekday ?? 1 } : {}), ...(freq === 'monthly' ? { monthDay: s.monthDay ?? 1 } : {}) } });
          }}>{(['daily', 'weekly', 'monthly'] as const).map((f) => <option key={f} value={f}>{t(`p10.freq.${f}`)}</option>)}</select></Field>
          <Field label={t('p10.rb.atIst')}><input className="input" type="time" value={s.at} onChange={(e) => set({ schedule: { ...s, at: e.target.value } })} /></Field>
          {s.freq === 'weekly' && <Field label={t('p10.rb.weekday')}><select className="input" value={s.weekday ?? 1} onChange={(e) => set({ schedule: { ...s, weekday: Number(e.target.value) } })}>
            {[0, 1, 2, 3, 4, 5, 6].map((w) => <option key={w} value={w}>{t(`p10.wd.${w}` as 'p10.wd.1')}</option>)}</select></Field>}
          {s.freq === 'monthly' && <Field label={t('p10.rb.monthDay')} hint={t('p10.rb.monthDayHint')}><input className="input" type="number" min={1} max={28} value={s.monthDay ?? 1} onChange={(e) => set({ schedule: { ...s, monthDay: Number(e.target.value) } })} /></Field>}
          <p className="text-sm sm:col-span-4" data-testid="schedule-preview">{errors.length ? '' : scheduleText(s, t)}</p>
        </div>}
      {errors.map((x, i) => <p key={i} role="alert" className="text-xs text-overdue">{x}</p>)}
    </section>
  );
}

function GroupEditor({ g, root, ev, errors, onChange, onRemove }: { g: GroupNode; root?: boolean; ev: AutomationEvent; errors: Record<string, string>; onChange(g: GroupNode): void; onRemove?(): void }) {
  const t = useT();
  const fields = fieldsFor(ev);
  const upd = (id: string, f: (n: Node) => Node | null) => onChange(updateNode(g, id, f));
  return (
    <div className={`space-y-2 ${root ? '' : 'rounded border border-border p-2'}`} role="group" aria-label={t('p10.rb.group')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select className="input w-auto" aria-label={t('p10.rb.match')} value={g.mode} onChange={(e) => onChange({ ...g, mode: e.target.value as 'all' | 'any' })}>
          <option value="all">{t('p10.rb.all')}</option><option value="any">{t('p10.rb.any')}</option></select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={g.negate} onChange={(e) => onChange({ ...g, negate: e.target.checked })} /> {t('p10.rb.not')}</label>
        {!root && onRemove && <button type="button" className="btn ml-auto" onClick={onRemove}>{t('p10.rb.removeGroup')}</button>}
      </div>
      {g.children.map((c) => c.kind === 'group'
        ? <GroupEditor key={c.id} g={c} ev={ev} errors={errors} onChange={(x) => upd(c.id, () => x)} onRemove={() => upd(c.id, () => null)} />
        : <LeafEditor key={c.id} l={c} fields={fields} error={errors[c.id]} onChange={(x) => upd(c.id, () => x)} onRemove={() => upd(c.id, () => null)} />)}
      {!g.children.length && <p className="text-xs text-muted">{root ? t('p10.rb.noConditions') : t('p10.rb.emptyGroup')}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn" onClick={() => onChange({ ...g, children: [...g.children, { id: nid(), kind: 'leaf', field: fields[0] ?? 'event.type', op: 'eq', raw: '' }] })}><Plus size={14} aria-hidden /> {t('p10.rb.addCondition')}</button>
        <button type="button" className="btn" onClick={() => onChange({ ...g, children: [...g.children, { id: nid(), kind: 'group', mode: g.mode === 'all' ? 'any' : 'all', negate: false, children: [] }] })}><Plus size={14} aria-hidden /> {t('p10.rb.addGroup')}</button>
      </div>
    </div>
  );
}

function LeafEditor({ l, fields, error, onChange, onRemove }: { l: LeafNode; fields: string[]; error?: string; onChange(l: LeafNode): void; onRemove(): void }) {
  const t = useT();
  const label = useAutoLabel();
  const ft = fieldType(l.field);
  const ops = opsFor(ft);
  const hint = isPaiseField(l.field) ? t('p10.rb.rupeesHint') : ft === 'date' ? t('p10.rb.dateHint') : isList(l.op) ? t('p10.rb.listHint') : null;
  return (
    <div className="flex flex-wrap items-start gap-2" data-testid="leaf">
      <select className="input w-auto" aria-label={t('p10.rb.field')} value={l.field} onChange={(e) => { const f = e.target.value; const o = opsFor(fieldType(f)); onChange({ ...l, field: f, op: o.includes(l.op) ? l.op : o[0]!, raw: '' }); }}>
        {!fields.includes(l.field) && <option value={l.field}>{label('field', l.field)}</option>}
        {fields.map((f) => <option key={f} value={f}>{label('field', f)}{isPaiseField(f) ? ' (₹)' : ''}</option>)}</select>
      <select className="input w-auto" aria-label={t('p10.rb.op')} value={l.op} onChange={(e) => onChange({ ...l, op: e.target.value as LeafNode['op'] })}>
        {ops.map((o) => <option key={o} value={o}>{label('op', o)}</option>)}</select>
      {needsValue(l.op) && (ft === 'boolean' && !isList(l.op)
        ? <select className="input w-auto" aria-label={t('p10.rb.value')} value={l.raw} onChange={(e) => onChange({ ...l, raw: e.target.value })}>
          <option value="">—</option><option value="true">{t('p10.yes')}</option><option value="false">{t('p10.no')}</option></select>
        : <div><input className={`input w-48 ${error ? 'border-overdue' : ''}`} aria-label={t('p10.rb.value')} aria-invalid={!!error} type={ft === 'date' && !isList(l.op) ? 'date' : 'text'}
          inputMode={ft === 'number' ? 'decimal' : undefined} value={l.raw} onChange={(e) => onChange({ ...l, raw: e.target.value })} />
          {hint && !error && <span className="block text-xs text-muted">{hint}</span>}</div>)}
      <button type="button" className="rounded p-1 text-muted hover:text-overdue" aria-label={t('p10.rb.removeCondition')} onClick={onRemove}><Trash2 size={14} /></button>
      {error && <span role="alert" className="basis-full text-xs text-overdue">{error === 'field_unavailable' ? t('p10.rb.fieldUnavailable') : error}</span>}
    </div>
  );
}

function AddAction({ offered, onAdd }: { offered: ActionType[]; onAdd(t: ActionType): void }) {
  const t = useT();
  const label = useAutoLabel();
  const [v, setV] = useState('');
  return (
    <div className="flex gap-2">
      <select className="input w-auto" aria-label={t('p10.rb.actionType')} value={v} onChange={(e) => setV(e.target.value)}>
        <option value="">{t('p10.rb.pickAction')}</option>{offered.map((a) => <option key={a} value={a}>{label('action', a)}</option>)}</select>
      <button type="button" className="btn" disabled={!v} onClick={() => { onAdd(v as ActionType); setV(''); }}><Plus size={14} aria-hidden /> {t('p10.rb.addAction')}</button>
    </div>
  );
}

function PersonPick({ label: l, value, onChange }: { label: string; value: unknown; onChange(v: unknown): void }) {
  const lab = useAutoLabel();
  const users = useUsers().data ?? [];
  const cur = typeof value === 'string' ? `ref:${value}` : value && typeof value === 'object' ? `user:${(value as { userId: string }).userId}` : '';
  return <select className="input" aria-label={l} value={cur} onChange={(e) => { const [k, x] = e.target.value.split(':') as [string, string]; onChange(k === 'ref' ? x : { userId: x }); }}>
    {PERSON_REFS.map((p) => <option key={p} value={`ref:${p}`}>{lab('person', p)}</option>)}
    {users.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}
  </select>;
}

function ActionEditor({ a, i, scan, errors, onChange, onRemove }: { a: Act; i: number; scan: boolean; errors: string[]; onChange(a: Act): void; onRemove(): void }) {
  const t = useT();
  const label = useAutoLabel();
  const [rate, setRate] = useState(typeof a.ratePaise === 'number' && a.ratePaise ? String(a.ratePaise / 100) : '');
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const txt = (k: string, l: string, area = false) => <Field label={l}>{area
    ? <textarea className="input min-h-16" value={s(k)} onChange={(e) => onChange({ ...a, [k]: e.target.value })} />
    : <input className="input" value={s(k)} onChange={(e) => onChange({ ...a, [k]: e.target.value })} />}</Field>;
  const num = (k: string, l: string) => <Field label={l}><input className="input" type="number" value={a[k] === undefined ? '' : String(a[k])} onChange={(e) => onChange({ ...a, [k]: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>;
  const sel = (k: string, l: string, opts: readonly string[], fam: string) => <Field label={l}><select className="input" value={s(k)} onChange={(e) => onChange({ ...a, [k]: e.target.value })}>
    {opts.map((o) => <option key={o} value={o}>{label(fam, o)}</option>)}</select></Field>;
  return (
    <fieldset className="space-y-2 rounded border border-border p-2" aria-label={`${i + 1}. ${label('action', a.type)}`} data-testid={`action-${i}`}>
      <legend className="flex items-center gap-2 px-1 text-sm font-medium">{i + 1}. {label('action', a.type)}
        {(a.type === 'ai_draft_message' || a.type === 'ai_classify_upload') && <span className="rounded border border-due-soon px-1 text-xs text-due-soon">{t('p10.rb.aiApproval')}</span>}
        {a.type === 'create_invoice_draft' && <span className="rounded border border-due-soon px-1 text-xs text-due-soon">{t('p10.rb.neverIssued')}</span>}
      </legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {scan && sel('when', t('p10.rb.when'), ['always', 'first', 'repeat'], 'when')}
        {a.type === 'create_task' && <>{txt('title', t('p10.af.title'))}<Field label={t('p10.af.assignee')}><PersonPick label={t('p10.af.assignee')} value={a.assignee} onChange={(v) => onChange({ ...a, assignee: v })} /></Field>
          {num('dueInDays', t('p10.af.dueInDays'))}{sel('priority', t('p10.af.priority'), TASK_PRIORITIES, 'priority')}
          <Field label={t('p10.af.checklist')} hint={t('p10.af.onePerLine')}><textarea className="input" value={((a.checklist as string[]) ?? []).join('\n')} onChange={(e) => onChange({ ...a, checklist: e.target.value.split('\n').filter((x) => x.trim()) })} /></Field>
          {txt('description', t('p10.rb.description'), true)}</>}
        {a.type === 'assign_task' && <Field label={t('p10.af.to')}><PersonPick label={t('p10.af.to')} value={a.to} onChange={(v) => onChange({ ...a, to: v })} /></Field>}
        {a.type === 'add_checklist_item' && <>{txt('label', t('p10.af.label'))}<label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={!!a.required} onChange={(e) => onChange({ ...a, required: e.target.checked })} /> {t('p10.af.required')}</label></>}
        {a.type === 'set_task_status' && <>{sel('status', t('p10.af.status'), TASK_STATUSES, 'tstatus')}{txt('pendingIssue', t('p10.af.pendingIssue'))}</>}
        {a.type === 'send_message' && <>{sel('channel', t('p7.f.channel'), COMM_CHANNELS, 'channel')}{txt('templateId', t('p10.af.templateId'))}{txt('subject', t('p7.f.subject'))}
          <div className="sm:col-span-3">{txt('body', t('p7.f.message'), true)}</div><p className="text-xs text-muted sm:col-span-3">{t('p10.af.messageHint')}</p></>}
        {a.type === 'create_pbc_request' && <Field label={t('p10.af.pbcItems')} hint={t('p10.af.onePerLine')}><textarea className="input" value={((a.items as Array<{ title: string }>) ?? []).map((x) => x.title).join('\n')}
          onChange={(e) => onChange({ ...a, items: e.target.value.split('\n').map((x) => ({ title: x })) })} /></Field>}
        {a.type === 'notify' && <>{txt('title', t('p10.af.title'))}<Field label={t('p10.af.to')}><PersonPick label={t('p10.af.to')} value={(a.to as unknown[])?.[0]} onChange={(v) => onChange({ ...a, to: [v, ...((a.to as unknown[]) ?? []).slice(1)] })} /></Field>
          {sel('priority', t('p10.af.priority'), ['low', 'normal', 'high', 'critical'], 'priority')}{txt('body', t('p7.f.message'), true)}</>}
        {a.type === 'add_timeline_note' && <div className="sm:col-span-3">{txt('body', t('p7.tl.note'), true)}</div>}
        {a.type === 'create_invoice_draft' && <>{txt('description', t('p10.rb.description'))}
          <Field label={t('p10.af.rate')}><input className={`input text-right ${rate && parseRupees(rate) === null ? 'border-overdue' : ''}`} inputMode="decimal" value={rate}
            onChange={(e) => { setRate(e.target.value); const p = parseRupees(e.target.value); onChange({ ...a, ratePaise: p ?? -1 }); }} /></Field>
          {txt('sac', 'SAC')}{num('gstRate', t('p10.af.gstRate'))}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={a.linkTask !== false} onChange={(e) => onChange({ ...a, linkTask: e.target.checked })} /> {t('p10.af.linkTask')}</label></>}
        {a.type === 'request_esign' && txt('title', t('p10.af.title'))}
        {a.type === 'ai_draft_message' && <>{sel('channel', t('p7.f.channel'), COMM_CHANNELS, 'channel')}<div className="sm:col-span-2">{txt('instruction', t('p10.af.instruction'), true)}</div></>}
        {a.type === 'ai_classify_upload' && <p className="text-sm text-muted sm:col-span-3">{t('p10.af.classifyHint')}</p>}
      </div>
      {errors.map((x, k) => <p key={k} role="alert" className="text-xs text-overdue">{x}</p>)}
      <div className="flex justify-end"><button type="button" className="btn" onClick={onRemove}><Trash2 size={14} aria-hidden /> {t('p10.rb.removeAction')}</button></div>
    </fieldset>
  );
}

function LadderEditor({ d, set }: { d: Draft; set(p: Partial<Draft>): void }) {
  const t = useT();
  const l = d.ladder;
  return (
    <section className="card space-y-2 p-3" aria-label={t('p10.rb.ladder')}>
      <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={!!l} onChange={(e) => set({ ladder: e.target.checked ? { everyDays: 3, maxSteps: 3, stopOn: [], escalate: [] } : null })} /> {t('p10.rb.ladder')}</label>
      {l && <div className="grid gap-2 sm:grid-cols-3">
        <Field label={t('p10.rb.everyDays')}><input className="input" type="number" min={1} value={l.everyDays} onChange={(e) => set({ ladder: { ...l, everyDays: Number(e.target.value) } })} /></Field>
        <Field label={t('p10.rb.maxSteps')}><input className="input" type="number" min={1} value={l.maxSteps} onChange={(e) => set({ ladder: { ...l, maxSteps: Number(e.target.value) } })} /></Field>
        <p className="self-end text-xs text-muted">{t('p10.rb.ladderHint', { stop: l.stopOn.join(', ') || '—', esc: l.escalate.length })}</p>
      </div>}
    </section>
  );
}

function LimitsEditor({ d, set }: { d: Draft; set(p: Partial<Draft>): void }) {
  const t = useT();
  const l = d.limits;
  const [cap, setCap] = useState(String(l.monthlyCostCapPaise / 100));
  const n = (k: keyof typeof l, lab: string) => <Field label={lab}><input className="input" type="number" min={1} value={l[k]} onChange={(e) => set({ limits: { ...l, [k]: Number(e.target.value) } })} /></Field>;
  return (
    <details className="card p-3"><summary className="cursor-pointer font-semibold">{t('p10.rb.limits')}</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-4">
        {n('maxActionsPerRun', t('p10.lim.perRun'))}{n('maxActionsPerDay', t('p10.lim.perDay'))}
        <Field label={t('p10.lim.cap')}><input className="input text-right" inputMode="decimal" value={cap} onChange={(e) => { setCap(e.target.value); set({ limits: { ...l, monthlyCostCapPaise: parseRupees(e.target.value) ?? -1 } }); }} /></Field>
        {n('pauseAfterFailures', t('p10.lim.pause'))}
      </div>
    </details>
  );
}

function DryRunPanel({ rule, scope, def, ok }: { rule?: Rule; scope: RuleScope; def: unknown; ok: boolean }) {
  const t = useT();
  const err = useAutoError();
  const label = useAutoLabel();
  const [limit, setLimit] = useState(20);
  const [entityType, setEntityType] = useState(''); const [entityId, setEntityId] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const b = { limit, ...(entityType && entityId.trim() ? { entityType, entityId: entityId.trim() } : {}), definition: def };
      return rule ? asFull<DryRun>(api.POST('/automation/rules/{id}/dry-run', { params: { path: { id: rule.id } }, body: body(b) }))
        : asFull<DryRun>(api.POST('/automation/dry-run', { body: body({ ...b, scope }) }));
    },
  });
  const sections = [...new Set(Object.keys(CONTEXT_FIELDS).map((f) => f.split('.')[0]!).filter((s) => s !== 'event' && s !== 'entity'))];
  return (
    <section className="card space-y-2 p-3" aria-label={t('p10.dr.title')}>
      <h2 className="font-semibold">{t('p10.dr.title')}</h2>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('p10.dr.recent')}><input className="input w-24" type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 20)} /></Field>
        <Field label={t('p10.dr.entityType')}><select className="input" value={entityType} onChange={(e) => setEntityType(e.target.value)}><option value="">{t('p10.dr.recentEvents')}</option>
          {sections.map((s) => <option key={s} value={s}>{label('section', s)}</option>)}</select></Field>
        {entityType && <Field label={t('p10.dr.entityId')}><input className="input w-80 font-mono" value={entityId} onChange={(e) => setEntityId(e.target.value)} /></Field>}
        <button type="button" className="btn btn-primary" disabled={!ok || m.isPending} onClick={() => m.mutate()}>{m.isPending ? t('p10.dr.running') : t('p10.dr.run')}</button>
      </div>
      {!ok && <p className="text-xs text-muted">{t('p10.dr.fixFirst')}</p>}
      {m.isError && <p role="alert" className="text-sm text-overdue">{err(m.error)}</p>}
      {m.data && <DryRunView r={m.data} />}
    </section>
  );
}

function Versions({ rule }: { rule: Rule }) {
  const t = useT();
  const { data } = useQuery({ queryKey: ['automation', 'versions', rule.id, rule.version], queryFn: () => asFull<{ items: Version[] }>(api.GET('/automation/rules/{id}/versions', { params: { path: { id: rule.id } } })).then((r) => r.items) });
  const [sel, setSel] = useState<number | null>(null);
  const items = data ?? [];
  const cur = items.find((v) => v.version === sel);
  const prev = cur ? items.find((v) => v.version < cur.version) : undefined;
  return (
    <section className="card space-y-2 p-3" aria-label={t('p10.ver.title')}>
      <h2 className="font-semibold">{t('p10.ver.title')}</h2>
      <ul className="divide-y divide-border text-sm">{items.map((v) => (
        <li key={v.version} className="flex flex-wrap items-center gap-2 py-1">
          <span className="font-medium">v{v.version}</span><span>{v.note ?? ''}</span><time className="text-xs text-muted" dateTime={v.changedAt}>{formatDateTime(v.changedAt)}</time>
          {v.version > 1 && <button type="button" className="btn ml-auto" aria-pressed={sel === v.version} onClick={() => setSel(sel === v.version ? null : v.version)}>{t('p10.ver.diff', { v: v.version })}</button>}
        </li>))}</ul>
      {cur && prev && <pre className="max-h-96 overflow-auto rounded bg-surface-alt p-2 text-xs" data-testid="version-diff">
        {lineDiff(pretty(prev.definition), pretty(cur.definition)).map((l, i) => <div key={i} className={l.op === '+' ? 'text-done' : l.op === '-' ? 'text-overdue' : 'text-muted'}>{l.op} {l.text}</div>)}</pre>}
    </section>
  );
}
