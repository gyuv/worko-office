import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { fetchBlob, openBlob, saveBlob } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { parseRupees } from './logic';

export const Money = ({ p, className = '' }: { p: number | null | undefined; className?: string }) =>
  <span className={`tabular-nums ${className}`}>{p === null || p === undefined ? '—' : formatINR(p)}</span>;

export const useEntities = () => useQuery({ queryKey: ['billing', 'entities'], queryFn: () => unwrap(api.GET('/billing/entities')), staleTime: 60_000 });
export const useBillingSettings = () => useQuery({ queryKey: ['billing', 'settings'], queryFn: () => unwrap(api.GET('/billing/settings')), staleTime: 60_000 });

const TONE: Record<string, string> = { draft: 'text-muted', issued: 'text-primary', partially_paid: 'text-due-soon', paid: 'text-done', cancelled: 'text-muted line-through' };
export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  return <span className={`rounded bg-surface-alt px-1.5 py-0.5 text-xs ${TONE[status] ?? ''}`}>{t(`bill.status.${status}` as MessageKey)}</span>;
}

/** Marks integrations whose external behaviour is mocked / not yet verified against official docs. */
export function MockBadge() {
  const t = useT();
  return <span className="rounded border border-border px-1.5 py-0.5 text-xs text-due-soon" title={t('bill.mockHint')}>{t('bill.mock')}</span>;
}

/** Rupee input that reports paise (null while invalid). */
export function RupeeInput({ value, onChange, label, required, id }: { value: string; onChange(v: string): void; label: string; required?: boolean; id?: string }) {
  const bad = value !== '' && parseRupees(value) === null;
  return <input id={id} className={`input text-right tabular-nums ${bad ? 'border-overdue' : ''}`} inputMode="decimal" aria-label={label} aria-invalid={bad} required={required}
    value={value} onChange={(e) => onChange(e.target.value)} />;
}

export async function openPdf(path: string) { openBlob((await fetchBlob(path)).blob); }
export async function download(path: string, fallback: string) { const { blob, filename } = await fetchBlob(path); saveBlob(blob, filename ?? fallback); }
