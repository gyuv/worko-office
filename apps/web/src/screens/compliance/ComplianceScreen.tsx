import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, rupeesToPaise } from '@worko/domain';
import { formatDate, formatDateTime, type MessageKey } from '@worko/i18n';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Field, Tabs } from '../../components/Dialog';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { shiftMonth } from '../tasks/logic';
import { TaskDrawer } from '../tasks/TaskDrawer';
import { useRuleMessage } from '../tasks/shared';
import { buildMatrix, cellTone, TONE_CLASS, toneCounts, type CellTone } from './logic';

type Tab = 'matrix' | 'extensions' | 'packs' | 'latefee';
type PackRule = { id: string; form: string; regime: string; frequency: string; verified: boolean };

const useRules = () => useQuery({
  queryKey: ['rules', 'pack'], staleTime: 300_000,
  queryFn: async () => (await unwrap(api.GET('/rules/pack'))) as unknown as { id: string; version: string; rules: PackRule[] },
});

export function ComplianceScreen() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('matrix');
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('nav.compliance')}</h1>
      <Tabs<Tab> label={t('nav.compliance')} value={tab} onChange={setTab}
        tabs={[['matrix', t('comp.tab.matrix')], ['extensions', t('comp.tab.extensions')], ['packs', t('comp.tab.packs')], ['latefee', t('comp.tab.latefee')]]} />
      {tab === 'matrix' && <MatrixTab />}
      {tab === 'extensions' && <ExtensionsTab />}
      {tab === 'packs' && <PacksTab />}
      {tab === 'latefee' && <LateFeeTab />}
    </div>
  );
}

const TONES: CellTone[] = ['done', 'open', 'dueSoon', 'overdue', 'notCreated', 'missing'];

function MatrixTab() {
  const t = useT();
  const today = todayIst();
  const [fromM, setFromM] = useState(today.slice(0, 7));
  const [toM, setToM] = useState(shiftMonth(today.slice(0, 7), 1));
  const [openTask, setOpenTask] = useState<string | null>(null);
  const from = `${fromM}-01`;
  const to = lastOfMonth(toM);
  const m = useQuery({ queryKey: ['compliance', 'matrix', from, to, today], queryFn: () => unwrap(api.GET('/compliance/matrix', { params: { query: { from, to, asOf: today } } })), enabled: fromM <= toM });
  const built = m.data ? buildMatrix(m.data) : null;
  const counts = m.data ? toneCounts(m.data) : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('comp.from')}><input type="month" className="input w-40" value={fromM} onChange={(e) => setFromM(e.target.value)} /></Field>
        <Field label={t('comp.to')}><input type="month" className="input w-40" value={toM} onChange={(e) => setToM(e.target.value)} /></Field>
        <ul className="ml-auto flex flex-wrap gap-2 text-xs" aria-label={t('comp.legend')}>
          {TONES.map((k) => <li key={k} className="flex items-center gap-1"><span className={`inline-block h-3 w-3 rounded ${TONE_CLASS[k]}`} aria-hidden />{t(`comp.tone.${k}` as MessageKey)}{counts ? ` (${counts[k]})` : ''}</li>)}
        </ul>
      </div>
      {m.isError && <p role="alert" className="text-overdue">{t('common.error')}</p>}
      {m.data && built && (!m.data.clients.length || !built.columns.length ? <p className="card p-6 text-muted">{t('comp.matrixEmpty')}</p> : (
        <div className="card max-h-[70vh] overflow-auto">
          <table className="table text-xs">
            <thead className="sticky top-0 bg-surface"><tr><th className="sticky left-0 bg-surface">{t('tasks.f.client')}</th>
              {built.columns.map((c) => <th key={`${c.ruleId}|${c.periodKey}`} className="whitespace-nowrap" title={c.ruleId}>{c.form}<div className="font-normal text-muted">{c.label}</div></th>)}</tr></thead>
            <tbody>
              {m.data.clients.map((cl) => (
                <tr key={cl.id}>
                  <th scope="row" className="sticky left-0 whitespace-nowrap bg-surface text-left font-normal"><a className="underline" href={`#/clients/${cl.id}`}>{cl.name}</a></th>
                  {built.columns.map((col) => {
                    const c = built.cell(cl.id ?? '', col);
                    if (!c) return <td key={col.ruleId + col.periodKey} />;
                    const tone = cellTone(c, m.data.asOf);
                    const label = `${cl.name} · ${col.form} ${col.label}: ${t(`comp.tone.${tone}` as MessageKey)} · ${formatDate(c.statutoryDue)}`;
                    return (
                      <td key={col.ruleId + col.periodKey} className="p-0.5">
                        {c.taskId ? <button className={`block w-full rounded px-1 py-0.5 ${TONE_CLASS[tone]}`} title={label} aria-label={label} data-tone={tone} onClick={() => setOpenTask(c.taskId!)}>{formatDate(c.statutoryDue).slice(0, 6)}</button>
                          : <span className={`block rounded px-1 py-0.5 text-center ${TONE_CLASS[tone]}`} title={label} aria-label={label} data-tone={tone}>{formatDate(c.statutoryDue).slice(0, 6)}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {openTask && <TaskDrawer id={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  );
}
function lastOfMonth(month: string) { const [y, m] = month.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

function ExtensionsTab() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const ruleMsg = useRuleMessage();
  const rules = useRules();
  const list = useQuery({ queryKey: ['compliance', 'extensions'], queryFn: () => unwrap(api.GET('/compliance/extensions')) });
  const [ruleId, setRuleId] = useState('');
  const [periodKey, setPeriodKey] = useState('');
  const [newDue, setNewDue] = useState('');
  const [note, setNote] = useState('');
  const [scope, setScope] = useState('');
  const [scopeErr, setScopeErr] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (scopeObj: Record<string, unknown> | undefined) => unwrap(api.POST('/compliance/extensions', { body: { ruleId, periodKey: periodKey.trim(), newDueDate: newDue, notification: note.trim() || null, ...(scopeObj ? { scope: scopeObj as Record<string, never> } : {}) } })),
    onSuccess: (r) => { setSel(r.id); void qc.invalidateQueries({ queryKey: ['compliance', 'extensions'] }); },
  });
  const submit = () => {
    setScopeErr('');
    let s: Record<string, unknown> | undefined;
    if (scope.trim()) { try { s = JSON.parse(scope) as Record<string, unknown>; } catch { setScopeErr(t('comp.ext.scopeInvalid')); return; } }
    create.mutate(s);
  };
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-3">
        {can('compliance', 'edit') && (
          <form className="card space-y-2 p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <h2 className="font-semibold">{t('comp.ext.new')}</h2>
            <Field label={t('comp.rule')}>
              <select className="input" required value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
                <option value="">—</option>
                {(rules.data?.rules ?? []).map((r) => <option key={r.id} value={r.id}>{r.form} · {r.regime} ({r.id})</option>)}
              </select>
            </Field>
            <Field label={t('comp.ext.period')} hint={t('comp.ext.periodHint')}><input className="input" required value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} /></Field>
            <Field label={t('comp.ext.newDue')}><input type="date" className="input" required value={newDue} onChange={(e) => setNewDue(e.target.value)} /></Field>
            <Field label={t('comp.ext.notification')}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <Field label={t('comp.ext.scope')} hint={t('comp.ext.scopeHint')} error={scopeErr}><textarea className="input font-mono text-xs" value={scope} onChange={(e) => setScope(e.target.value)} /></Field>
            {create.isError && <p role="alert" className="text-overdue">{ruleMsg(create.error)}</p>}
            <button className="btn btn-primary" disabled={create.isPending}>{t('comp.ext.createDraft')}</button>
          </form>
        )}
        <div className="card overflow-auto">
          <table className="table w-full text-sm">
            <thead><tr><th>{t('comp.rule')}</th><th>{t('comp.ext.period')}</th><th>{t('comp.ext.newDue')}</th><th>{t('comp.status')}</th></tr></thead>
            <tbody>{(list.data ?? []).map((x) => (
              <tr key={x.id} className={sel === x.id ? 'bg-surface-alt' : ''}>
                <td><button className="underline" onClick={() => setSel(x.id)}>{x.ruleId}</button></td><td>{x.periodKey}</td><td>{formatDate(x.newDueDate)}</td>
                <td>{t(`comp.st.${x.status}` as MessageKey)}{x.tasksMoved != null && <span className="text-xs text-muted"> · {t('comp.ext.moved', { count: x.tasksMoved })}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
          {list.data && !list.data.length && <p className="p-4 text-muted">{t('comp.ext.empty')}</p>}
        </div>
      </div>
      {sel && <ExtensionImpact id={sel} draft={list.data?.find((x) => x.id === sel)?.status === 'draft'} />}
    </div>
  );
}

function ExtensionImpact({ id, draft }: { id: string; draft: boolean }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const ruleMsg = useRuleMessage();
  const imp = useQuery({ queryKey: ['compliance', 'ext-impact', id], queryFn: () => unwrap(api.GET('/compliance/extensions/{id}/impact', { params: { path: { id } } })) });
  const approve = useMutation({
    mutationFn: () => unwrap(api.POST('/compliance/extensions/{id}/approve', { params: { path: { id } } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['compliance'] }); void qc.invalidateQueries({ queryKey: ['tasks'] }); },
  });
  const d = imp.data;
  return (
    <section className="card space-y-2 p-3" aria-label={t('comp.ext.impact')}>
      <h2 className="font-semibold">{t('comp.ext.impact')}</h2>
      {!d && <p className="text-muted">{t('common.loading')}</p>}
      {d && (
        <>
          <p role="status" className="text-lg font-medium">{t('comp.ext.impactSummary', { dates: d.dueDatesChanged, clients: d.clientsAffected })}</p>
          <p className="text-sm text-muted">{t('comp.ext.tasksToMove', { count: d.tasksToMove })}</p>
          {d.tasks.length > 0 && (
            <div className="max-h-72 overflow-auto rounded border border-border">
              <table className="table w-full text-xs">
                <thead><tr><th>{t('tasks.f.client')}</th><th>{t('tasks.title')}</th><th>{t('comp.ext.fromDate')}</th><th>{t('comp.ext.toDate')}</th></tr></thead>
                <tbody>{d.tasks.map((x) => <tr key={x.id}><td>{x.clientName}</td><td>{x.title}</td><td>{x.from ? formatDate(x.from) : '—'}</td><td>{x.to ? formatDate(x.to) : '—'}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {draft && can('compliance', 'approve') && <button className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate()}>{t('comp.approve')}</button>}
          {approve.data && <p role="status" className="text-done">{t('comp.ext.approved', { count: approve.data.tasksMoved })}</p>}
          {approve.isError && <p role="alert" className="text-overdue">{ruleMsg(approve.error)}</p>}
        </>
      )}
    </section>
  );
}

function PacksTab() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const ruleMsg = useRuleMessage();
  const packs = useQuery({ queryKey: ['compliance', 'packs'], queryFn: () => unwrap(api.GET('/compliance/packs')) });
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const upload = useMutation({
    mutationFn: (pack: Record<string, unknown>) => unwrap(api.POST('/compliance/packs', { body: { pack: pack as Record<string, never> } })),
    onSuccess: (r) => { setSel(r.id); void qc.invalidateQueries({ queryKey: ['compliance', 'packs'] }); },
  });
  const approve = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/compliance/packs/{id}/approve', { params: { path: { id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['compliance'] }),
  });
  const onFile = async (f: File | undefined) => {
    setErr('');
    if (!f) return;
    try { upload.mutate(JSON.parse(await f.text()) as Record<string, unknown>); } catch { setErr(t('comp.pack.badJson')); }
  };
  const selected = packs.data?.find((p) => p.id === sel);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-2">
        {can('compliance', 'edit') && (
          <label className="card block p-3 text-sm"><span className="label">{t('comp.pack.upload')}</span>
            <input type="file" accept="application/json,.json" onChange={(e) => void onFile(e.target.files?.[0])} /></label>
        )}
        {(err || upload.isError) && <p role="alert" className="text-overdue">{err || ruleMsg(upload.error)}</p>}
        <div className="card overflow-auto">
          <table className="table w-full text-sm">
            <thead><tr><th>{t('comp.pack.pack')}</th><th>{t('comp.pack.version')}</th><th>{t('comp.pack.rules')}</th><th>{t('comp.status')}</th><th>{t('comp.pack.uploaded')}</th></tr></thead>
            <tbody>{(packs.data ?? []).map((p) => (
              <tr key={p.id} className={sel === p.id ? 'bg-surface-alt' : ''}>
                <td><button className="underline" onClick={() => setSel(p.id)}>{p.packId}</button></td><td>{p.version}</td><td>{p.ruleCount ?? '—'}</td>
                <td>{t(`comp.st.${p.status}` as MessageKey)}</td><td>{p.createdAt ? formatDateTime(p.createdAt) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      {selected && (
        <section className="card space-y-2 p-3" aria-label={t('comp.pack.diff')}>
          <h2 className="font-semibold">{t('comp.pack.diff')} — {selected.packId} {selected.version}</h2>
          <PackDiff id={selected.id} />
          {selected.status === 'draft' && can('compliance', 'approve') && <button className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate(selected.id)}>{t('comp.approve')}</button>}
          {approve.isError && <p role="alert" className="text-overdue">{ruleMsg(approve.error)}</p>}
        </section>
      )}
    </div>
  );
}

function PackDiff({ id }: { id: string }) {
  const t = useT();
  const d = useQuery({ queryKey: ['compliance', 'pack-diff', id], queryFn: () => unwrap(api.GET('/compliance/packs/{id}/diff', { params: { path: { id } } })) }).data;
  if (!d) return <p className="text-muted">{t('common.loading')}</p>;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">{t('comp.pack.vs', { from: d.from.version ?? '—', to: d.to.version ?? '—' })}</p>
      <p role="status" className="font-medium">{t('comp.ext.impactSummary', { dates: d.impact.dueDatesChanged ?? 0, clients: d.impact.clientsAffected ?? 0 })}</p>
      <DiffList title={t('comp.pack.added')} items={d.added} tone="text-done" sign="+" />
      <DiffList title={t('comp.pack.removed')} items={d.removed} tone="text-overdue" sign="−" />
      <DiffList title={t('comp.pack.changed')} items={d.changed.map((c) => `${c.rule}: ${(c.fields ?? []).join(', ')}`)} tone="text-due-soon" sign="~" />
      {(d.impact.changes ?? []).length > 0 && (
        <div className="max-h-60 overflow-auto rounded border border-border">
          <table className="table w-full text-xs"><thead><tr><th>{t('comp.rule')}</th><th>{t('comp.ext.period')}</th><th>{t('comp.ext.fromDate')}</th><th>{t('comp.ext.toDate')}</th></tr></thead>
            <tbody>{d.impact.changes!.slice(0, 200).map((c, i) => <tr key={i}><td>{c.ruleId}</td><td>{c.periodKey}</td><td>{c.from ? formatDate(c.from) : '—'}</td><td>{c.to ? formatDate(c.to) : '—'}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}
function DiffList({ title, items, tone, sign }: { title: string; items: string[]; tone: string; sign: string }) {
  if (!items.length) return null;
  return <div><h3 className="font-semibold">{title} ({items.length})</h3><ul className={`font-mono text-xs ${tone}`}>{items.map((x) => <li key={x}>{sign} {x}</li>)}</ul></div>;
}

function LateFeeTab() {
  const t = useT();
  const ruleMsg = useRuleMessage();
  const rules = useRules();
  const [ruleId, setRuleId] = useState('');
  const [due, setDue] = useState('');
  const [filed, setFiled] = useState(todayIst());
  const [tax, setTax] = useState('');
  const [nil, setNil] = useState(false);
  const calc = useMutation({
    mutationFn: () => unwrap(api.POST('/compliance/late-fee', { body: { ruleId, dueDate: due, filedOn: filed, nilReturn: nil, ...(tax ? { taxAmountPaise: rupeesToPaise(Number(tax)) } : {}) } })),
  });
  const r = calc.data;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <form className="card space-y-2 p-3" onSubmit={(e) => { e.preventDefault(); calc.mutate(); }}>
        <p role="note" className="flex items-start gap-2 rounded border border-due-soon p-2 text-sm"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-due-soon" aria-hidden /> {t('comp.fee.banner')}</p>
        <Field label={t('comp.rule')}>
          <select className="input" required value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
            <option value="">—</option>
            {(rules.data?.rules ?? []).map((x) => <option key={x.id} value={x.id}>{x.form} · {x.regime}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('comp.fee.due')}><input type="date" className="input" required value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label={t('comp.fee.filed')}><input type="date" className="input" required value={filed} onChange={(e) => setFiled(e.target.value)} /></Field>
        </div>
        <Field label={t('comp.fee.tax')}><input type="number" min="0" step="0.01" className="input" value={tax} onChange={(e) => setTax(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={nil} onChange={(e) => setNil(e.target.checked)} /> {t('comp.fee.nil')}</label>
        <button className="btn btn-primary" disabled={calc.isPending}>{t('comp.fee.calc')}</button>
        {calc.isError && <p role="alert" className="text-overdue">{ruleMsg(calc.error)}</p>}
      </form>
      {r && (
        <section className="card space-y-2 p-3" aria-label={t('comp.fee.result')}>
          <div className="flex items-center gap-2"><h2 className="font-semibold">{t('comp.fee.result')}</h2>
            <span className="rounded bg-due-soon px-1.5 py-0.5 text-xs font-semibold text-primary-fg">{t('comp.fee.indicative')}</span>
            {!r.verified && <span className="rounded border border-overdue px-1.5 py-0.5 text-xs text-overdue">{t('comp.fee.unverified')}</span>}</div>
          {!r.supported ? <p className="text-muted">{t('comp.fee.unsupported')}</p> : (
            <>
              <p className="text-sm text-muted">{t('comp.fee.daysLate', { days: r.daysLate, months: r.monthsLate ?? 0 })}</p>
              <table className="table w-full text-sm"><tbody>
                {r.lines.map((l, i) => <tr key={i}><td>{l.label}</td><td className="text-right font-mono">{formatINR(l.amountPaise ?? 0)}</td></tr>)}
                <tr className="font-semibold"><td>{t('comp.fee.total')}</td><td className="text-right font-mono">{formatINR(r.totalPaise)}</td></tr>
              </tbody></table>
            </>
          )}
          {r.penaltyHint && <p className="text-xs text-muted">{r.penaltyHint}</p>}
          <p className="text-xs text-muted">{r.disclaimer}</p>
        </section>
      )}
    </div>
  );
}
