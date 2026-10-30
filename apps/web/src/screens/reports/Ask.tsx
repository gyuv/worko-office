import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { datasetMeta, columnMeta, type ReportFilter } from '@worko/domain';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { useAiFeature } from '../ai/api';
import { as, asFull, body, type AskAnswer, type AskHistory, type SavedReport } from './api';
import { Chart } from './Chart';
import { aliasLabel, aliasType, chartData, filterRange, fmtIstDate, fmtIstDateTime, formatCell, reportError } from './logic';
import { ExportButtons, HiddenNotice, ReportResult, useReportError } from './ResultView';

export const ASK_EXAMPLES = ['unbilled GST work FY 25-26 by user', 'overdue tasks by assignee', 'collections by month this FY', 'open notices by authority'] as const;

/** Ask is offered only when GET /ai/availability says nl_query is ok and the user has ai:create (plus reports:view). */
export function useAskAvailable() {
  const can = useCan();
  const ai = useAiFeature('nl_query');
  return can('reports', 'view') && ai;
}

/** Human-readable interpretation of a proposed definition: dataset, filters (with resolved IST ranges), grouping. */
export function Interpretation({ a }: { a: Pick<AskAnswer, 'definition' | 'explanation' | 'sources'> }) {
  const t = useT();
  const d = a.definition; const meta = datasetMeta(d.dataset);
  const L = (k: string) => (meta && columnMeta(meta, k)?.label) ?? k;
  const today = todayIst();
  const fText = (f: ReportFilter) => {
    const range = (f.op === 'fy' || f.op === 'period') && typeof f.value === 'string' ? filterRange(f.op, f.value, today) : null;
    const v = Array.isArray(f.value) ? f.value.join(', ') : f.value === undefined ? '' : String(f.value);
    return `${L(f.column)} ${t(`p11.op.${f.op}`)} ${v}${range ? ` (${fmtIstDate(range.from)} – ${fmtIstDate(range.to)})` : ''}`.trim();
  };
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]" data-testid="ask-interpretation">
      <dt className="text-muted">{t('p11.ask.dataset')}</dt><dd data-testid="ask-dataset">{meta?.label ?? d.dataset}</dd>
      <dt className="text-muted">{t('p11.ask.filters')}</dt><dd data-testid="ask-filters">{d.filters.length ? d.filters.map(fText).join('; ') : t('p11.ask.none')}</dd>
      <dt className="text-muted">{t('p11.ask.grouping')}</dt><dd data-testid="ask-grouping">{d.groupBy.length ? d.groupBy.map(L).join(' → ') : t('p11.ask.none')}</dd>
      <dt className="text-muted">{t('p11.ask.summary')}</dt><dd>{a.explanation}</dd>
      <dt className="text-muted">{t('p11.ask.sources')}</dt>
      <dd data-testid="ask-sources">{a.sources.map((s) => `${s.label}: ${s.columns.map(L).join(', ')}`).join(' · ')}</dd>
    </dl>
  );
}

export function AskView() {
  const t = useT();
  const can = useCan();
  const err = useReportError();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const available = useAskAvailable();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [saveName, setSaveName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const history = useQuery({ queryKey: ['reports', 'ask'], enabled: available, queryFn: () => as<{ items: AskHistory[] }>(api.GET('/reports/ask')).then((r) => r.items) });
  const ask = useMutation({
    mutationFn: (q: string) => asFull<AskAnswer>(api.POST('/reports/ask', { body: body({ question: q }) })),
    onSuccess: (a) => { setAnswer(a); setSaveName(question.trim().slice(0, 120)); void qc.invalidateQueries({ queryKey: ['reports', 'ask'] }); },
    onError: (e) => {
      setAnswer(null);
      const r = reportError(e);
      setError(r.code === 'invalid_model_output' ? `${t('p11.err.invalid_model_output')}${r.issues.length ? ` (${r.issues.slice(0, 3).join('; ')})` : ''}` : err(e));
      void qc.invalidateQueries({ queryKey: ['reports', 'ask'] });
    },
  });
  const save = useMutation({
    mutationFn: () => asFull<SavedReport>(api.POST('/reports/ask/{id}/save', { params: { path: { id: answer!.id } }, body: body({ name: saveName.trim() }) })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['reports', 'saved'] }); toast({ text: t('p11.ask.savedAs', { name: r.name }), tone: 'ok' }); go(`reports/builder/${r.id}`); },
    onError: (e) => setError(err(e)),
  });
  if (!available) return <p className="card p-6 text-muted" data-testid="ask-off">{t('p11.ask.off')}</p>;
  const submit = (q: string) => { if (q.trim().length < 3) return; setError(null); setQuestion(q); ask.mutate(q.trim()); };
  const r = answer?.result;
  const cd = r && r.groups.length ? chartData(r) : null;
  return (
    <div className="space-y-3" data-testid="ask">
      <form className="card space-y-2 p-3" onSubmit={(e) => { e.preventDefault(); submit(question); }}>
        <Field label={t('p11.ask.question')} hint={t('p11.ask.hint')}>
          <input className="input" value={question} maxLength={500} onChange={(e) => setQuestion(e.target.value)} placeholder={ASK_EXAMPLES[0]} />
        </Field>
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted">{t('p11.ask.try')}</span>
          {ASK_EXAMPLES.map((x) => <button key={x} type="button" className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-surface-alt" onClick={() => submit(x)}>{x}</button>)}
        </div>
        <button type="submit" className="btn btn-primary" disabled={ask.isPending || question.trim().length < 3}><Sparkles size={12} aria-hidden />{ask.isPending ? t('p11.ask.thinking') : t('p11.ask.ask')}</button>
      </form>
      {error && <p role="alert" className="card p-3 text-overdue" data-testid="ask-error">{error}</p>}
      {answer && (
        <section className="card space-y-3 p-3" data-testid="ask-answer">
          <p className="inline-flex items-center gap-1 rounded bg-surface-alt px-2 py-0.5 text-xs font-medium" data-testid="ask-badge"><Sparkles size={12} aria-hidden />{t('p11.ask.badge')}{answer.mock ? ` · ${t('p11.ask.mock')}` : ''}</p>
          <Interpretation a={answer} />
          {r && <>
            <HiddenNotice dataset={r.dataset.key} hidden={r.hiddenColumns} />
            {cd && <Chart data={cd} label={cd.yLabel} />}
            <AnswerTable r={r} />
            <ExportButtons source={{ definition: answer.definition }} />
          </>}
          {!r && <ReportResult source={{ definition: answer.definition }} showParams={false} />}
          {can('reports', 'create') && <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
            <Field label={t('p11.f.name')}><input className="input" value={saveName} onChange={(e) => setSaveName(e.target.value)} /></Field>
            <button type="button" className="btn" disabled={!saveName.trim() || save.isPending} onClick={() => save.mutate()}>{t('p11.ask.save')}</button>
          </div>}
        </section>
      )}
      <section className="space-y-1" aria-labelledby="ask-recent">
        <h3 id="ask-recent" className="text-sm font-semibold">{t('p11.ask.recent')}</h3>
        <ul className="space-y-1" data-testid="ask-history">
          {(history.data ?? []).map((h) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-sm">
              <span><button type="button" className="underline" onClick={() => { setQuestion(h.question); }}>{h.question}</button>
                <span className="ml-2 text-xs text-muted">{fmtIstDateTime(h.createdAt)} · {t(`p11.ask.status.${h.status}` as never) === `p11.ask.status.${h.status}` ? h.status : t(`p11.ask.status.${h.status}` as never)}</span></span>
              {h.savedReportId ? <a className="text-xs underline" href={`#/reports/builder/${h.savedReportId}`}>{t('p11.ask.openSaved')}</a>
                : h.definition ? <button type="button" className="text-xs underline" onClick={() => setAnswer({ id: h.id, status: h.status, definition: h.definition!, explanation: h.explanation ?? '', sources: h.sources, provider: h.provider ?? '', model: '', mock: h.provider === 'mock', costPaise: 0, result: null })}>{t('p11.ask.reopen')}</button> : null}
            </li>
          ))}
          {history.data && !history.data.length && <li className="text-sm text-muted">{t('p11.ask.noRecent')}</li>}
        </ul>
      </section>
    </div>
  );
}

function AnswerTable({ r }: { r: NonNullable<AskAnswer['result']> }) {
  const t = useT();
  if (r.groups.length) {
    const aggs = r.definition.aggregates;
    const meta = datasetMeta(r.dataset.key);
    const gk = r.definition.groupBy[0]!;
    return (
      <div className="overflow-auto"><table className="table w-full text-sm" data-testid="ask-results"><thead><tr><th>{(meta && columnMeta(meta, gk)?.label) ?? gk}</th>{aggs.map((a) => <th key={a.as} className="text-right">{aliasLabel(r, a.as)}</th>)}</tr></thead>
        <tbody>{r.groups.map((g) => <tr key={JSON.stringify(g.key)}><td>{g.label}</td>{aggs.map((a) => <td key={a.as} className="text-right tabular-nums">{formatCell(g.values[a.as], aliasType(r, a.as))}</td>)}</tr>)}</tbody></table></div>
    );
  }
  return (
    <div className="overflow-auto"><table className="table w-full text-sm" data-testid="ask-results"><thead><tr>{r.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
      <tbody>{!r.rows.length && <tr><td className="text-muted">{t('p11.empty')}</td></tr>}{r.rows.map((row, i) => <tr key={i}>{r.columns.map((c) => <td key={c.key}>{formatCell(row.values[c.key], c.type)}</td>)}</tr>)}</tbody></table></div>
  );
}
