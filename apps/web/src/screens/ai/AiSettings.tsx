import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AI_FEATURES, aiSettingsSchema, formatINR, type AiSettings } from '@worko/domain';
import { useEffect, useState } from 'react';
import { Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api } from '../../lib/session';
import { parseRupees } from '../billing/logic';
import { RupeeInput } from '../billing/shared';
import { CapMeter } from '../comm/shared';
import { istMonth } from '../automation/logic';
import { asFull, body, useAiError, useAiSettings, useAiUsage } from './api';
import { aiStatus } from './logic';

const rupees = (p: number | null) => (p === null ? '' : (p / 100).toFixed(2).replace(/\.00$/, ''));

/** Settings → AI: opt-in (off by default) with the privacy explanation, per-feature toggles, caps, retention, usage. */
export function AiSettingsPanel() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const err = useAiError();
  const q = useAiSettings();
  const [d, setD] = useState<AiSettings | null>(null);
  const [cap, setCap] = useState(''); const [userCap, setUserCap] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (q.data) { const { provider: _p, model: _m, external: _e, envNoAi: _n, ...s } = q.data; setD(s); setCap(rupees(s.monthlyCapPaise)); setUserCap(rupees(s.perUserMonthlyCapPaise)); } }, [q.data]);
  const save = useMutation({
    mutationFn: (s: AiSettings) => asFull(api.PUT('/ai/settings', { body: body(s) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ai'] }); toast({ text: t('p10.saved'), tone: 'ok' }, 3000); },
    onError: (e) => setError(err(e)),
  });
  if (q.isLoading || !d || !q.data) return <p className="text-muted">{t('common.loading')}</p>;
  const s = q.data;
  const edit = can('settings', 'edit') && !s.envNoAi;
  const status = aiStatus(s);
  const mock = s.provider === 'mock' || !s.external;
  const submit = () => {
    setError(null);
    const capP = parseRupees(cap); const uc = userCap.trim() === '' ? null : parseRupees(userCap);
    const parsed = aiSettingsSchema.safeParse({ ...d, monthlyCapPaise: capP ?? -1, perUserMonthlyCapPaise: uc === null && userCap.trim() !== '' ? -1 : uc });
    if (!parsed.success) { setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; }
    save.mutate(parsed.data);
  };
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('p10.as.title')}</h1>
        <span data-testid="ai-status" className={`rounded px-1.5 py-0.5 text-xs ${status === 'on' ? 'bg-surface-alt text-done' : 'bg-surface-alt text-muted'}`}>{t(`p10.as.status.${status}`)}</span>
        <span className="text-sm text-muted">{t('p10.as.provider', { provider: s.provider, model: s.model })}</span>
        {mock && <span className="rounded border border-due-soon px-1.5 py-0.5 text-xs text-due-soon" title={t('p10.as.mockHint')}>{t('p10.as.mock')}</span>}
      </header>
      {s.envNoAi && <p role="status" className="card border-due-soon p-3 text-sm">{t('p10.as.envNoAi')}</p>}
      <section className="card space-y-2 p-3 text-sm" aria-label={t('p10.as.privacy')}>
        <h2 className="font-semibold">{t('p10.as.privacy')}</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('p10.as.p.redact')}</li><li>{t('p10.as.p.storage')}</li><li>{t('p10.as.p.approval')}</li><li>{t('p10.as.p.off')}</li>
        </ul>
      </section>
      <form className="card space-y-3 p-3" onSubmit={(e) => { e.preventDefault(); if (edit) submit(); }}>
        <label className="flex items-center gap-2 font-medium"><input type="checkbox" disabled={!edit} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> {t('p10.as.enable')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!edit} checked={d.noAiMode} onChange={(e) => setD({ ...d, noAiMode: e.target.checked })} /> {t('p10.as.noAiMode')}</label>
        <fieldset className="space-y-1" disabled={!edit || !d.enabled || d.noAiMode}>
          <legend className="label">{t('p10.as.features')}</legend>
          {AI_FEATURES.map((f) => <label key={f} className="flex items-center gap-2"><input type="checkbox" checked={d.features[f]} onChange={(e) => setD({ ...d, features: { ...d.features, [f]: e.target.checked } })} /> {t(`p10.feat.${f}`)}</label>)}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('p10.as.cap')}><RupeeInput label={t('p10.as.cap')} value={cap} onChange={setCap} /></Field>
          <Field label={t('p10.as.userCap')} hint={t('p10.as.noCapHint')}><RupeeInput label={t('p10.as.userCap')} value={userCap} onChange={setUserCap} /></Field>
          <Field label={t('p10.as.retention')}><input className="input" type="number" min={1} max={3650} disabled={!edit} value={d.retentionDays} onChange={(e) => setD({ ...d, retentionDays: Number(e.target.value) })} /></Field>
          <label className="flex items-center gap-2 self-end"><input type="checkbox" disabled={!edit} checked={d.redactClientNames} onChange={(e) => setD({ ...d, redactClientNames: e.target.checked })} /> {t('p10.as.redactNames')}</label>
        </div>
        {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
        {edit && <div className="flex justify-end"><button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button></div>}
      </form>
      <AiUsage />
    </div>
  );
}

function AiUsage() {
  const t = useT();
  const [month, setMonth] = useState(istMonth());
  const u = useAiUsage(month).data;
  return (
    <section className="card space-y-2 p-3" aria-label={t('p10.as.usage')}>
      <div className="flex flex-wrap items-end gap-2"><h2 className="font-semibold">{t('p10.as.usage')}</h2>
        <Field label={t('p10.month')}><input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field></div>
      {u && <>
        <CapMeter label={t('p10.as.usageTotal')} usedPaise={u.totalPaise} capPaise={u.capPaise} />
        <table className="table w-full text-sm"><thead><tr><th>{t('p10.as.feature')}</th><th>{t('p10.as.calls')}</th><th>{t('p10.as.tokens')}</th><th className="text-right">{t('p10.cost')}</th></tr></thead>
          <tbody>{u.byFeature.map((r) => <tr key={r.key}><td>{t(`p10.feat.${r.key}` as 'p10.feat.ask')}</td><td>{r.calls}</td><td>{r.inputTokens + r.outputTokens}</td><td className="text-right tabular-nums">{formatINR(r.costPaise)}</td></tr>)}
            {!u.byFeature.length && <tr><td colSpan={4} className="text-muted">{t('p10.none')}</td></tr>}</tbody></table>
      </>}
    </section>
  );
}
