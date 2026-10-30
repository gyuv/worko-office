import { formatINR } from '@worko/domain';
import { formatDate } from '@worko/i18n';
import { useT } from '../../lib/i18n';
import { useAutoLabel } from './api';
import { groupDryRun, type DryItem, type DryRun } from './logic';

/** "Exactly what would happen": entities, per-action plans, consent/permission/cap refusals, cost estimate. Nothing is executed. */
export function DryRunView({ r }: { r: DryRun }) {
  const t = useT();
  const label = useAutoLabel();
  const g = groupDryRun(r);
  return (
    <section className="space-y-3" aria-label={t('p10.dr.title')} data-testid="dry-run">
      <p className="rounded bg-surface-alt p-2 text-xs">{t('p10.dr.readOnly', { date: formatDate(`${r.asOf}T12:00:00+05:30`) })}</p>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <div><dt className="text-muted">{t('p10.dr.evaluated')}</dt><dd className="font-semibold">{r.evaluated}</dd></div>
        <div><dt className="text-muted">{t('p10.dr.matched')}</dt><dd className="font-semibold" data-testid="dr-matched">{r.matched}</dd></div>
        <div><dt className="text-muted">{t('p10.dr.willDo')}</dt><dd className="font-semibold">{g.willDo}</dd></div>
        <div><dt className="text-muted">{t('p10.dr.messages')}</dt><dd className="font-semibold">{g.messages}</dd></div>
        <div><dt className="text-muted">{t('p10.dr.cost')}</dt><dd className="font-semibold tabular-nums" data-testid="dr-cost">{formatINR(r.estimatedCostPaise)}</dd></div>
      </dl>
      {g.overCap && <p role="alert" className="text-sm text-overdue">{t('p10.dr.overCap', { used: formatINR(r.monthToDateCostPaise), cap: formatINR(r.capPaise) })}</p>}
      {!!g.refusals.length && <div className="text-sm" data-testid="dr-refusals"><span className="font-medium">{t('p10.dr.refusals')}</span>{' '}
        {g.refusals.map(([c, n]) => <span key={c} className="mr-2 rounded bg-surface-alt px-1.5 text-due-soon">{label('code', c)} × {n}</span>)}</div>}
      {!r.items.length && <p className="text-sm text-muted">{t('p10.dr.noEvents')}</p>}
      {!!g.matched.length && <ItemList title={t('p10.dr.wouldAct')} items={g.matched} />}
      {Object.entries(g.skipped).map(([reason, items]) => <ItemList key={reason} title={`${t('p10.dr.skipped')}: ${label('skip', reason)}`} items={items} muted />)}
      {!!g.unmatched.length && <ItemList title={t('p10.dr.noMatch')} items={g.unmatched} muted />}
    </section>
  );
}

function ItemList({ title, items, muted }: { title: string; items: DryItem[]; muted?: boolean }) {
  const t = useT();
  const label = useAutoLabel();
  return (
    <details open={!muted} className="card p-2">
      <summary className="cursor-pointer text-sm font-medium">{title} ({items.length})</summary>
      <ul className="mt-2 divide-y divide-border text-sm">
        {items.map((i) => (
          <li key={`${i.entity.type}:${i.entity.id}`} className="py-1.5">
            <div className="flex flex-wrap gap-2"><span className="font-medium">{i.clientName ?? '—'}</span><span className="text-xs text-muted">{label('section', i.entity.type)} · {i.entity.id.slice(0, 8)}</span>
              {i.step !== 'first' && <span className="text-xs">{label('step', i.step)}</span>}</div>
            {!i.matched && !i.skipped && <ul className="text-xs text-muted">{i.conditions.filter((c) => !c.ok).map((c, k) => <li key={k}>✗ {label('field', c.field)} {label('op', c.op)} — {t('p10.dr.actual')}: {JSON.stringify(c.actual)}</li>)}</ul>}
            {i.actions.map((a, k) => (
              <div key={k} className="ml-3 flex flex-wrap gap-2 text-xs" data-testid="dr-plan">
                <span className={a.wouldRefuse ? 'text-due-soon' : 'text-done'}>{a.wouldRefuse ? '⊘' : '✓'}</span>
                <span className="font-medium">{label('action', a.type)}</span><span>{a.summary}</span>
                {a.wouldRefuse && <span className="text-due-soon">{t('p10.dr.wouldRefuse')}: {label('code', a.wouldRefuse)}</span>}
                {a.costPaise > 0 && <span className="tabular-nums">{formatINR(a.costPaise)}</span>}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}
