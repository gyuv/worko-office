import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentTemplate, automationSettingsSchema, COMM_CHANNELS, formatINR, type AutomationSettings } from '@worko/domain';
import { formatDateTime } from '@worko/i18n';
import { ArrowLeft, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { isUuid, useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { parseRupees } from '../billing/logic';
import { CapMeter, NoAccess } from '../comm/shared';
import { asFull, body, useAgents, useAutoError, useAutoLabel, useAutomationSettings, useCosts, useRules, type Agent, type DryRun, type Rule, type Run, type RunDetail } from './api';
import { DryRunView } from './DryRunView';
import { canRetry, endOfIstDay, istMonth, paramKind, paramsFromRaw, rawFromParams, runActionTone } from './logic';
import { RuleBuilder } from './RuleBuilder';

type Tab = 'agents' | 'rules' | 'runs' | 'costs' | 'settings';

/** Phase 10 automation: `#/automation/{agents|rules|rules/new|rules/<id>|runs|runs/<id>|costs|settings}`. */
export function AutomationScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  if (!can('automation', 'view')) return <NoAccess />;
  const tab: Tab = (['agents', 'rules', 'runs', 'costs', 'settings'] as const).find((x) => x === params[0]) ?? 'agents';
  if (tab === 'rules' && params[1] === 'new') return <RuleBuilder />;
  if (tab === 'rules' && isUuid(params[1])) return <RuleLoader id={params[1]} />;
  if (tab === 'runs' && isUuid(params[1])) return <RunView id={params[1]} />;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p10.nav.automation')}</h1>
      <Tabs<Tab> label={t('p10.nav.automation')} value={tab} onChange={(v) => go(`automation/${v}`)}
        tabs={[['agents', t('p10.tab.agents')], ['rules', t('p10.tab.rules')], ['runs', t('p10.tab.runs')], ['costs', t('p10.tab.costs')], ['settings', t('p10.tab.settings')]]} />
      {tab === 'agents' && <AgentsGallery />}
      {tab === 'rules' && <RulesList />}
      {tab === 'runs' && <RunsList />}
      {tab === 'costs' && <CostsView />}
      {tab === 'settings' && <AutomationSettingsPanel />}
    </div>
  );
}

function RuleLoader({ id }: { id: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ['automation', 'rule', id], retry: false, queryFn: () => asFull<Rule>(api.GET('/automation/rules/{id}', { params: { path: { id } } })) });
  if (q.isError) return <p role="alert" className="card p-6">{t('p10.notFound')} <a className="underline" href="#/automation/rules">{t('p10.tab.rules')}</a></p>;
  if (!q.data) return <p className="text-muted">{t('common.loading')}</p>;
  return <RuleBuilder key={`${q.data.id}:${q.data.version}`} rule={q.data} />;
}

// ---------- Agents ----------
function AgentsGallery() {
  const t = useT();
  const can = useCan();
  const q = useAgents();
  const rules = useRules().data ?? [];
  const [open, setOpen] = useState<Agent | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">{t('p10.ag.hint')}</p>
      {q.isLoading && <p className="text-muted">{t('common.loading')}</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {(q.data ?? []).map((a) => { const on = rules.filter((r) => r.agentKey === a.key); return (
          <li key={a.key} className="card flex flex-col gap-2 p-3" data-testid={`agent-${a.key}`}>
            <h2 className="font-semibold">{a.name}</h2>
            <p className="flex-1 text-sm text-muted">{a.description}</p>
            <div className="flex items-center gap-2">
              {!!on.length && <span className="text-xs text-done">{t('p10.ag.active', { n: on.filter((r) => r.enabled).length })}</span>}
              {can('automation', 'create') && <button className="btn btn-primary ml-auto" onClick={() => setOpen(a)}>{t('p10.ag.setup')}</button>}
            </div>
          </li>); })}
      </ul>
      {open && <AgentDialog a={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function AgentDialog({ a, onClose }: { a: Agent; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const err = useAutoError();
  const label = useAutoLabel();
  const [raw, setRaw] = useState<Record<string, string>>(rawFromParams(a.defaults));
  const [name, setName] = useState(a.name);
  const [preview, setPreview] = useState<DryRun | null>(null);
  const params = paramsFromRaw(raw, a.defaults, COMM_CHANNELS);
  const tpl = agentTemplate(a.key);
  const v = tpl ? tpl.params.safeParse(params) : null;
  const issues: Record<string, string> = {};
  if (v && !v.success) for (const i of v.error.issues) issues[String(i.path[0] ?? '')] = i.message;
  const pv = useMutation({
    mutationFn: () => asFull<DryRun>(api.POST('/automation/agents/{key}/preview', { params: { path: { key: a.key } }, body: body({ params }) })),
    onSuccess: setPreview,
  });
  const en = useMutation({
    mutationFn: () => asFull<{ rule: Rule }>(api.POST('/automation/agents/{key}/enable', { params: { path: { key: a.key } }, body: body({ params, name: name.trim() || a.name, enabled: true }) })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['automation'] }); toast({ text: t('p10.ag.enabled', { name: r.rule.name }), tone: 'ok' }, 4000); onClose(); go('automation/rules'); },
  });
  const change = (k: string, val: string) => { setRaw({ ...raw, [k]: val }); setPreview(null); };
  return (
    <Dialog title={a.name} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-muted">{a.description}</p>
        <Field label={t('p10.rb.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid gap-2 sm:grid-cols-3">
          {Object.keys(a.defaults).concat(Object.keys(raw).filter((k) => !(k in a.defaults))).filter((k, i, xs) => xs.indexOf(k) === i).map((k) => {
            const pk = paramKind(k, a.defaults[k], COMM_CHANNELS);
            const l = label('param', k);
            return <Field key={k} label={l} error={issues[k] ?? null} hint={pk.kind === 'list' ? t('p10.rb.listHint') : null}>
              {pk.kind === 'boolean' ? <select className="input" value={raw[k] ?? 'false'} onChange={(e) => change(k, e.target.value)}><option value="true">{t('p10.yes')}</option><option value="false">{t('p10.no')}</option></select>
                : pk.kind === 'enum' ? <select className="input" value={raw[k] ?? ''} onChange={(e) => change(k, e.target.value)}>{pk.options.map((o) => <option key={o} value={o}>{label('channel', o)}</option>)}</select>
                  : <input className="input" inputMode={pk.kind === 'number' ? 'numeric' : undefined} value={raw[k] ?? ''} onChange={(e) => change(k, e.target.value)} />}
            </Field>;
          })}
          {a.key === 'document_collection' || a.key === 'renewal_reminder' ? <Field label={label('param', 'templateId')} error={issues.templateId ?? null} hint={t('p10.ag.templateHint')}>
            <input className="input font-mono" value={raw.templateId ?? ''} onChange={(e) => change('templateId', e.target.value)} /></Field> : null}
        </div>
        {(pv.isError || en.isError) && <p role="alert" className="text-sm text-overdue">{err(pv.error ?? en.error)}</p>}
        {preview && <DryRunView r={preview} />}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn" disabled={!v?.success || pv.isPending} onClick={() => pv.mutate()}>{pv.isPending ? t('p10.dr.running') : t('p10.ag.preview')}</button>
          <button type="button" className="btn btn-primary" disabled={!preview || !v?.success || en.isPending} title={preview ? undefined : t('p10.ag.previewFirst')} onClick={() => en.mutate()}>{t('p10.ag.enable')}</button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------- Rules ----------
function RulesList() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const err = useAutoError();
  const label = useAutoLabel();
  const q = useRules();
  const costs = useCosts().data;
  const op = useMutation({
    mutationFn: ({ id, op }: { id: string; op: 'enable' | 'disable' | 'resume' | 'delete' }) => op === 'delete'
      ? asFull(api.DELETE('/automation/rules/{id}', { params: { path: { id } } }))
      : asFull(api.POST(`/automation/rules/{id}/${op}` as '/automation/rules/{id}/enable', { params: { path: { id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['automation'] }),
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const rules = q.data ?? [];
  const cost = (id: string) => costs?.items.find((c) => c.ruleId === id)?.totalPaise ?? 0;
  return (
    <div className="space-y-2">
      {can('automation', 'create') && <div className="flex justify-end"><button className="btn btn-primary" onClick={() => go('automation/rules/new')}><Plus size={14} aria-hidden /> {t('p10.rb.new')}</button></div>}
      {q.isLoading && <p className="text-muted">{t('common.loading')}</p>}
      {!q.isLoading && !rules.length && <p className="card p-4 text-muted">{t('p10.rules.empty')}</p>}
      {!!rules.length && <div className="card overflow-auto"><table className="table w-full text-sm">
        <thead><tr><th>{t('p10.rb.name')}</th><th>{t('p10.rb.scope')}</th><th>{t('p10.rb.trigger')}</th><th>{t('p10.rules.state')}</th><th>{t('p10.rules.lastRun')}</th><th className="text-right">{t('p10.rules.costMonth')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
        <tbody>{rules.map((r) => (
          <tr key={r.id} data-testid={`rule-${r.id}`}>
            <td><a className="font-medium underline" href={`#/automation/rules/${r.id}`}>{r.name}</a> <span className="text-xs text-muted">v{r.version}</span></td>
            <td>{t(`p10.scope.${r.scope}`)}</td><td>{label('event', r.triggerEvent)}</td>
            <td>{r.status === 'paused' ? <span className="text-overdue">{t('p10.rules.paused')}{r.pausedReason ? `: ${r.pausedReason}` : ''}</span> : r.enabled ? <span className="text-done">{t('p10.rules.enabled')}</span> : <span className="text-muted">{t('p10.rules.disabled')}</span>}</td>
            <td>{r.lastRunAt ? formatDateTime(r.lastRunAt) : '—'}</td><td className="text-right tabular-nums">{formatINR(cost(r.id))}</td>
            <td className="whitespace-nowrap text-right">{can('automation', 'edit') && <>
              {r.status === 'paused' && <button className="btn" onClick={() => op.mutate({ id: r.id, op: 'resume' })}>{t('p10.rules.resume')}</button>}
              <button className="btn" onClick={() => op.mutate({ id: r.id, op: r.enabled ? 'disable' : 'enable' })}>{r.enabled ? t('p10.rules.disable') : t('p10.rules.enable')}</button>
              <button className="btn btn-danger" onClick={() => { if (confirm(t('p10.rules.deleteConfirm', { name: r.name }))) op.mutate({ id: r.id, op: 'delete' }); }}>{t('p10.rules.delete')}</button>
            </>}</td>
          </tr>))}</tbody></table></div>}
    </div>
  );
}

// ---------- Runs ----------
const RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed', 'skipped', 'no_match'] as const;
function RunsList() {
  const t = useT();
  const label = useAutoLabel();
  const rules = useRules().data ?? [];
  const [ruleId, setRuleId] = useState(''); const [status, setStatus] = useState(''); const [date, setDate] = useState('');
  const q = useQuery({
    queryKey: ['automation', 'runs', ruleId, status, date],
    queryFn: () => asFull<{ items: Run[] }>(api.GET('/automation/runs', { params: { query: { ...(ruleId ? { ruleId } : {}), ...(status ? { status } : {}), ...(date ? { before: endOfIstDay(date) } : {}) } } } as never)).then((r) => r.items),
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('p10.runs.rule')}><select className="input" value={ruleId} onChange={(e) => setRuleId(e.target.value)}><option value="">{t('p10.all')}</option>{rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label={t('p10.runs.status')}><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('p10.all')}</option>{RUN_STATUSES.map((s) => <option key={s} value={s}>{label('run', s)}</option>)}</select></Field>
        <Field label={t('p10.runs.onOrBefore')}><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {q.isLoading && <p className="text-muted">{t('common.loading')}</p>}
      {!q.isLoading && !q.data?.length && <p className="card p-4 text-muted">{t('p10.runs.empty')}</p>}
      {!!q.data?.length && <div className="card overflow-auto"><table className="table w-full text-sm">
        <thead><tr><th>{t('p10.runs.started')}</th><th>{t('p10.runs.rule')}</th><th>{t('p10.rb.event')}</th><th>{t('p10.runs.status')}</th><th>{t('p10.runs.actions')}</th><th className="text-right">{t('p10.cost')}</th></tr></thead>
        <tbody>{q.data.map((r) => (
          <tr key={r.id}><td><a className="underline" href={`#/automation/runs/${r.id}`}>{formatDateTime(r.startedAt)}</a></td><td>{r.ruleName}</td><td>{label('event', r.eventType)}</td>
            <td>{label('run', r.status)}{r.skipReason ? ` · ${label('skip', r.skipReason)}` : ''}</td><td>{r.actionsDone}/{r.actionsTotal}</td><td className="text-right tabular-nums">{formatINR(r.costPaise)}</td></tr>))}</tbody></table></div>}
    </div>
  );
}

function RunView({ id }: { id: string }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const err = useAutoError();
  const label = useAutoLabel();
  const q = useQuery({ queryKey: ['automation', 'run', id], retry: false, queryFn: () => asFull<RunDetail>(api.GET('/automation/runs/{id}', { params: { path: { id } } })) });
  const retry = useMutation({
    mutationFn: () => asFull<{ retried: number }>(api.POST('/automation/runs/{id}/retry', { params: { path: { id } } })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['automation'] }); toast({ text: t('p10.runs.retried', { n: r.retried }), tone: 'ok' }, 3000); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  if (q.isError) return <p role="alert" className="card p-6">{t('p10.notFound')}</p>;
  const r = q.data;
  if (!r) return <p className="text-muted">{t('common.loading')}</p>;
  const tone = { ok: 'text-done', refused: 'text-due-soon', failed: 'text-overdue', muted: 'text-muted' } as const;
  return (
    <div className="space-y-3">
      <a href="#/automation/runs" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('p10.tab.runs')}</a>
      <h1 className="text-xl font-semibold">{r.ruleName} · {formatDateTime(r.startedAt)}</h1>
      <p className="text-sm">{label('run', r.status)}{r.skipReason ? ` · ${label('skip', r.skipReason)}` : ''} · {label('event', r.eventType)} · {label('step', r.step)} · {formatINR(r.costPaise)}</p>
      {r.error && <p role="alert" className="text-sm text-overdue">{r.error}</p>}
      <ol className="card divide-y divide-border">{r.actions.map((a) => { const k = runActionTone(a.status); return (
        <li key={a.idx} className="flex flex-wrap gap-2 p-2 text-sm" data-testid={`run-action-${a.idx}`}>
          <span className="font-medium">{a.idx + 1}. {label('action', a.type)}</span>
          <span className={tone[k]}>{label('astatus', a.status)}</span>
          {a.code && <span className={tone[k]}>{k === 'refused' ? `${t('p10.runs.because')} ` : ''}{label('code', a.code)}</span>}
          {a.error && <span className="text-muted">{a.error}</span>}
          {a.costPaise > 0 && <span className="ml-auto tabular-nums">{formatINR(a.costPaise)}</span>}
        </li>); })}</ol>
      {canRetry(r.actions) && can('automation', 'edit') && <button className="btn btn-primary" disabled={retry.isPending} onClick={() => retry.mutate()}>{t('p10.runs.retry')}</button>}
    </div>
  );
}

// ---------- Costs ----------
function CostsView() {
  const t = useT();
  const [month, setMonth] = useState(istMonth());
  const c = useCosts(month).data;
  return (
    <section className="space-y-2" aria-label={t('p10.tab.costs')}>
      <Field label={t('p10.month')}><input className="input w-auto" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
      {c && <>
        <div className="card p-3"><CapMeter label={t('p10.costs.firm')} usedPaise={c.totalPaise} capPaise={c.capPaise} /></div>
        <div className="card overflow-auto"><table className="table w-full text-sm">
          <thead><tr><th>{t('p10.runs.rule')}</th><th className="text-right">{t('p10.costs.comm')}</th><th className="text-right">{t('p10.costs.ai')}</th><th>{t('p10.runs.actions')}</th><th className="w-64">{t('p10.costs.vsCap')}</th></tr></thead>
          <tbody>{c.items.map((i) => (
            <tr key={i.ruleId}><td>{i.name}</td><td className="text-right tabular-nums">{formatINR(i.commPaise)}</td><td className="text-right tabular-nums">{formatINR(i.aiPaise)}</td><td>{i.actions}</td>
              <td><CapMeter label={formatINR(i.totalPaise)} usedPaise={i.totalPaise} capPaise={i.capPaise} /></td></tr>))}
            {!c.items.length && <tr><td colSpan={5} className="text-muted">{t('p10.none')}</td></tr>}</tbody></table></div>
      </>}
    </section>
  );
}

// ---------- Settings ----------
function AutomationSettingsPanel() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const err = useAutoError();
  const q = useAutomationSettings();
  const [d, setD] = useState<AutomationSettings | null>(null);
  const [cap, setCap] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (q.data) { setD(q.data); setCap(String(q.data.monthlyCostCapPaise / 100)); } }, [q.data]);
  const save = useMutation({
    mutationFn: (s: AutomationSettings) => asFull(api.PUT('/automation/settings', { body: body(s) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['automation'] }); toast({ text: t('p10.saved'), tone: 'ok' }, 3000); },
    onError: (e) => setError(err(e)),
  });
  if (!d) return <p className="text-muted">{t('common.loading')}</p>;
  const edit = can('settings', 'edit');
  return (
    <form className="card max-w-2xl space-y-3 p-3" onSubmit={(e) => {
      e.preventDefault(); setError(null);
      const p = automationSettingsSchema.safeParse({ ...d, monthlyCostCapPaise: parseRupees(cap) ?? -1 });
      if (!p.success) setError(p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); else save.mutate(p.data);
    }}>
      <label className="flex items-center gap-2 font-medium"><input type="checkbox" disabled={!edit} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> {t('p10.set.enabled')}</label>
      <p className="text-xs text-muted">{t('p10.set.enabledHint')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('p10.set.perDay')}><input className="input" type="number" disabled={!edit} value={d.maxActionsPerDay} onChange={(e) => setD({ ...d, maxActionsPerDay: Number(e.target.value) })} /></Field>
        <Field label={t('p10.set.cap')}><input className="input text-right" inputMode="decimal" disabled={!edit} value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
        <Field label={t('p10.set.retention')}><input className="input" type="number" disabled={!edit} value={d.eventRetentionDays} onChange={(e) => setD({ ...d, eventRetentionDays: Number(e.target.value) })} /></Field>
      </div>
      {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
      {edit && <div className="flex justify-end"><button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button></div>}
    </form>
  );
}
