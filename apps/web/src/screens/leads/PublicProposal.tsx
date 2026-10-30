import { useMutation, useQuery } from '@tanstack/react-query';
import { formatINR, PRODUCT } from '@worko/domain';
import { formatDate, type MessageKey } from '@worko/i18n';
import { useState, type CSSProperties } from 'react';
import { Field } from '../../components/Dialog';
import { useT } from '../../lib/i18n';
import { publicJson, type PortalHttpError } from '../../portal/http';
import { accentColor } from '../../portal/logic';
import type { PublicProposal as View } from './api';
import { TotalsTable } from './ProposalEditor';

/** Logged-out e-accept page `#/proposal/{token}`: no Authorization header is ever sent (publicJson). */
export function PublicProposal({ token }: { token: string }) {
  const t = useT();
  const path = `/proposals/public/${encodeURIComponent(token)}`;
  const q = useQuery({ queryKey: ['public-proposal', token], retry: false, queryFn: () => publicJson<View>(path) });
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [mode, setMode] = useState<'accept' | 'decline'>('accept');
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: () => mode === 'accept'
      ? publicJson<{ status: string }>(`${path}/accept`, { method: 'POST', body: { name: name.trim(), agree: true } })
      : publicJson<{ status: string }>(`${path}/decline`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: () => void q.refetch(),
  });
  const style = { '--w-primary': accentColor(q.data?.accent, false) } as CSSProperties;
  const conflict = (decide.error as PortalHttpError | null)?.code;
  return (
    <main style={style} className="mx-auto min-h-screen max-w-3xl space-y-4 bg-bg p-4 text-fg">
      {q.isError ? <p role="alert" className="card p-4">{t('p9.pub.notFound')}</p> : !q.data ? <p className="text-muted">{t('common.loading')}</p> : (() => {
        const v = q.data;
        return <>
          <header><p className="text-sm text-muted">{v.firm}</p><h1 className="text-2xl font-semibold">{v.title}</h1>
            <p className="text-sm text-muted">{t('p9.pub.meta', { number: v.number, v: v.version, who: v.preparedFor ?? '' })}{v.validUntil ? ` · ${t('p9.pub.validUntil', { d: formatDate(v.validUntil) })}` : ''}</p></header>
          {v.state !== 'open' && <p role="status" className="card p-3" data-testid="pub-state">{t(`p9.pub.state.${v.state}` as MessageKey)}</p>}
          <section className="card overflow-x-auto p-4" aria-label={t('p9.pub.services')}>
            <table className="table w-full text-sm"><thead><tr><th>{t('p9.prop.desc')}</th><th>{t('p9.prop.freq')}</th><th className="text-right">{t('p9.prop.qty')}</th><th className="text-right">{t('p9.prop.fee')}</th><th className="text-right">GST</th></tr></thead>
              <tbody>{v.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td>{t(`p9.freq.${l.frequency}` as MessageKey)}</td><td className="text-right">{l.qty}</td><td className="text-right tabular-nums">{formatINR(l.feePaise - (l.discountPaise ?? 0))}</td><td className="text-right">{l.gstRate}%</td></tr>)}</tbody></table>
          </section>
          <section className="card p-4"><TotalsTable totals={v.totals} /></section>
          {v.terms && <section className="card p-4"><h2 className="font-semibold">{t('p9.prop.terms')}</h2><p className="whitespace-pre-wrap text-sm">{v.terms}</p></section>}
          {v.acceptable && (
            <form className="card space-y-3 p-4" aria-label={t('p9.pub.respond')} onSubmit={(e) => { e.preventDefault(); decide.mutate(); }}>
              <div className="flex gap-2" role="radiogroup" aria-label={t('p9.pub.respond')}>
                <button type="button" role="radio" aria-checked={mode === 'accept'} className={`btn ${mode === 'accept' ? 'btn-primary' : ''}`} onClick={() => setMode('accept')}>{t('p9.pub.accept')}</button>
                <button type="button" role="radio" aria-checked={mode === 'decline'} className={`btn ${mode === 'decline' ? 'btn-primary' : ''}`} onClick={() => setMode('decline')}>{t('p9.pub.decline')}</button>
              </div>
              {mode === 'accept' ? <>
                <Field label={t('p9.pub.typedName')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required minLength={2} /></Field>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> {t('p9.pub.agree', { firm: v.firm })}</label>
              </> : <Field label={t('p9.pub.reason')}><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={2} /></Field>}
              {decide.isError && <p role="alert" className="text-sm text-overdue">{conflict ? t(`p9.pub.state.${conflict === 'already_decided' ? 'superseded' : conflict}` as MessageKey) : (decide.error as Error).message}</p>}
              <button className="btn btn-primary" disabled={decide.isPending || (mode === 'accept' ? !(agree && name.trim().length >= 2) : reason.trim().length < 2)}>
                {mode === 'accept' ? t('p9.pub.confirmAccept') : t('p9.pub.confirmDecline')}</button>
              <p className="text-xs text-muted">{t('p9.pub.recorded')}</p>
            </form>
          )}
        </>;
      })()}
      <footer className="pt-6 text-center text-xs text-muted">{PRODUCT.name}</footer>
    </main>
  );
}
