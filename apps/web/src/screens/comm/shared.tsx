import { formatINR } from '@worko/domain';
import { useT } from '../../lib/i18n';
import { useLabel } from './api';

/** Consent state pill; opted-out is loud on purpose. */
export function ConsentBadge({ state }: { state: 'opted_in' | 'opted_out' | 'none' | 'no_address' }) {
  const t = useT();
  const tone = { opted_in: 'text-done', opted_out: 'bg-overdue text-primary-fg', none: 'text-muted', no_address: 'text-due-soon' }[state];
  return <span data-consent={state} className={`rounded px-1.5 py-0.5 text-xs font-medium ${state === 'opted_out' ? '' : 'bg-surface-alt'} ${tone}`}>{t(`p7.consent.${state}`)}</span>;
}

const TONE: Record<string, string> = {
  approved: 'text-done', completed: 'text-done', sent: 'text-done', delivered: 'text-done', read: 'text-done', active: 'text-done', confirmed: 'text-done',
  submitted: 'text-primary', pending_approval: 'text-due-soon', scheduled: 'text-primary', sending: 'text-primary', pending: 'text-primary', queued: 'text-primary',
  rejected: 'text-overdue', failed: 'text-overdue', error: 'text-overdue', cancelled: 'text-muted line-through', revoked: 'text-muted',
  skipped_optout: 'text-overdue', skipped_nocontact: 'text-due-soon', skipped_cap: 'text-due-soon',
};
export function StatusBadge({ status, family = 'status' }: { status: string; family?: string }) {
  const label = useLabel();
  return <span data-status={status} className={`rounded bg-surface-alt px-1.5 py-0.5 text-xs ${TONE[status] ?? 'text-muted'}`}>{label(family, status)}</span>;
}

/** Small badge for unverified/mock configuration. */
export function FlagBadge({ kind }: { kind: 'mock' | 'unverified' | 'verified' }) {
  const t = useT();
  return <span className={`rounded border px-1.5 py-0.5 text-xs ${kind === 'verified' ? 'border-done text-done' : 'border-due-soon text-due-soon'}`}>{t(`p7.flag.${kind}`)}</span>;
}

/** Spend vs cap bar (no cap ⇒ "No cap"). */
export function CapMeter({ label, usedPaise, capPaise }: { label: string; usedPaise: number; capPaise: number | null }) {
  const t = useT();
  const pct = capPaise ? Math.min(100, Math.round((usedPaise / capPaise) * 100)) : 0;
  const over = capPaise !== null && usedPaise > capPaise;
  return (
    <div>
      <div className="flex justify-between text-sm"><span>{label}</span>
        <span className="tabular-nums">{formatINR(usedPaise)}{capPaise !== null ? ` / ${formatINR(capPaise)}` : ` · ${t('p7.usage.noCap')}`}</span></div>
      {capPaise !== null && <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-1 h-2 overflow-hidden rounded bg-surface-alt">
        <div className={`h-full ${over ? 'bg-overdue' : pct >= 80 ? 'bg-due-soon' : 'bg-primary'}`} style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

export function NoAccess() {
  const t = useT();
  return <p className="card p-6 text-muted">{t('p6.noAccess')}</p>;
}
