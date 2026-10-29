import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { api } from '../../lib/session';
import { MockBadge } from '../billing/shared';
import { as, body, usePracticeSettings, useP8Error, type EsignRow, type PracticeSettings as PS } from './api';
import { parseThresholds, unverifiedProvider } from './logic';

type RunResult = { day: string; escalations: number; expiryAlerts: number; renewalTasks: number; pbcReminders: number; pbcSkipped: Array<{ reason: string }> };

/** Settings → Practice: notice buffer, expiry thresholds, PBC reminders, extractor (explicit AI opt-in), e-sign provider status, daily run. */
export function PracticeSettings() {
  const t = useT();
  const can = useCan();
  const err = useP8Error();
  const qc = useQueryClient();
  const me = useMe().data;
  const firmWide = !!me?.grants.some((g) => g.module === 'settings' && g.action === 'edit' && g.scope === 'all');
  const q = usePracticeSettings();
  const esign = useQuery({ queryKey: ['p8', 'esign', 'latest'], enabled: can('documents', 'view'),
    queryFn: () => as<{ items: EsignRow[] }>(api.GET('/esign/requests', { params: { query: { limit: 1 } as never } })) });
  const [s, setS] = useState<PS | null>(null);
  const [dscT, setDscT] = useState('');
  const [licT, setLicT] = useState('');
  const [aiAck, setAiAck] = useState(false);
  const [run, setRun] = useState<RunResult | null>(null);
  useEffect(() => { if (q.data) { setS(q.data); setDscT(q.data.dsc.thresholds.join(', ')); setLicT(q.data.licences.thresholds.join(', ')); } }, [q.data]);
  const save = useMutation({
    mutationFn: (b: PS) => as<PS>(api.PUT('/practice/settings', { body: body(b) })),
    onSuccess: (x) => { qc.setQueryData(['p8', 'settings'], x); toast({ text: t('p8.ps.saved'), tone: 'ok' }); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const runNow = useMutation({
    mutationFn: () => as<RunResult>(api.POST('/practice/run', { body: {} as never })),
    onSuccess: setRun, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  if (!s) return <p className="text-muted">{t('common.loading')}</p>;
  const ro = !firmWide;
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  const dsc = parseThresholds(dscT); const lic = parseThresholds(licT);
  const aiTurningOn = s.ai.noticeExtraction && !q.data?.ai.noticeExtraction;
  const provider = esign.data?.items[0]?.provider ?? null;
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (dsc && lic && (!aiTurningOn || aiAck)) save.mutate({ ...s, dsc: { ...s.dsc, thresholds: dsc }, licences: { ...s.licences, thresholds: lic } }); }}>
      <h1 className="text-xl font-semibold">{t('p8.ps.title')}</h1>
      {ro && <p className="text-sm text-muted">{t('p8.ps.readOnly')}</p>}
      <fieldset disabled={ro} className="space-y-4">
        <section className="card grid gap-3 p-3 sm:grid-cols-3" aria-label={t('p8.nav.notices')}>
          <h2 className="font-medium sm:col-span-3">{t('p8.nav.notices')}</h2>
          <Field label={t('p8.ps.buffer')} hint={t('p8.ps.bufferHint')}><input type="number" min={0} max={60} className="input" value={s.notices.taskBufferDays} onChange={(e) => setS({ ...s, notices: { ...s.notices, taskBufferDays: num(e.target.value) } })} /></Field>
          <Field label={t('p8.ps.prepDays')}><input type="number" min={0} max={30} className="input" value={s.notices.hearingPrepDays} onChange={(e) => setS({ ...s, notices: { ...s.notices, hearingPrepDays: num(e.target.value) } })} /></Field>
          <Field label={t('p8.ps.escalate')}><input type="number" min={15} className="input" value={s.notices.escalateAfterMinutes} onChange={(e) => setS({ ...s, notices: { ...s.notices, escalateAfterMinutes: num(e.target.value) } })} /></Field>
        </section>
        <section className="card grid gap-3 p-3 sm:grid-cols-2" aria-label={t('p8.ps.alerts')}>
          <h2 className="font-medium sm:col-span-2">{t('p8.ps.alerts')}</h2>
          <Field label={t('p8.ps.dscThresholds')} error={dsc ? null : t('p8.ps.badThresholds')} hint={t('p8.ps.thresholdHint')}><input className="input" value={dscT} onChange={(e) => setDscT(e.target.value)} /></Field>
          <Field label={t('p8.ps.dscTask')}><input type="number" min={0} className="input" value={s.dsc.renewalTaskDays} onChange={(e) => setS({ ...s, dsc: { ...s.dsc, renewalTaskDays: num(e.target.value) } })} /></Field>
          <Field label={t('p8.ps.licThresholds')} error={lic ? null : t('p8.ps.badThresholds')}><input className="input" value={licT} onChange={(e) => setLicT(e.target.value)} /></Field>
          <Field label={t('p8.ps.licTask')}><input type="number" min={0} className="input" value={s.licences.renewalTaskDays} onChange={(e) => setS({ ...s, licences: { ...s.licences, renewalTaskDays: num(e.target.value) } })} /></Field>
        </section>
        <section className="card grid gap-3 p-3 sm:grid-cols-3" aria-label={t('p8.a.pbc')}>
          <h2 className="font-medium sm:col-span-3">{t('p8.a.pbc')}</h2>
          <Field label={t('p8.ps.pbcEvery')}><input type="number" min={1} className="input" value={s.pbc.reminderEveryDays} onChange={(e) => setS({ ...s, pbc: { ...s.pbc, reminderEveryDays: Math.max(1, num(e.target.value)) } })} /></Field>
          <Field label={t('p8.ps.pbcMax')}><input type="number" min={0} className="input" value={s.pbc.maxReminders} onChange={(e) => setS({ ...s, pbc: { ...s.pbc, maxReminders: num(e.target.value) } })} /></Field>
          <Field label={t('p8.ps.pbcChannel')}><select className="input" value={s.pbc.channel} onChange={(e) => setS({ ...s, pbc: { ...s.pbc, channel: e.target.value as 'email' } })}>
            {(['email', 'whatsapp', 'sms'] as const).map((c) => <option key={c} value={c}>{t(`p7.channel.${c}`)}</option>)}</select></Field>
        </section>
        <section className="card space-y-2 p-3" aria-label={t('p8.ps.extractor')}>
          <h2 className="font-medium">{t('p8.ps.extractor')}</h2>
          <p className="text-sm">{t('p8.ps.extractorDefault')}</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.ai.noticeExtraction} onChange={(e) => { setS({ ...s, ai: { noticeExtraction: e.target.checked } }); setAiAck(false); }} /> {t('p8.ps.aiToggle')}</label>
          <p className="rounded border border-due-soon p-2 text-sm" data-testid="ai-privacy">{t('p8.ps.aiPrivacy')}</p>
          {aiTurningOn && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={aiAck} onChange={(e) => setAiAck(e.target.checked)} /> {t('p8.ps.aiAck')}</label>}
          <p className="text-xs text-muted">{t('p8.ps.aiServer')}</p>
        </section>
      </fieldset>
      <section className="card space-y-1 p-3" aria-label={t('p8.ps.esign')}>
        <h2 className="font-medium">{t('p8.ps.esign')}</h2>
        <p className="text-sm">{provider ? t('p8.ps.esignLast', { provider }) : t('p8.ps.esignUnknown')} {unverifiedProvider(provider) && <MockBadge />}</p>
        <p className="text-xs text-muted">{t('p8.ps.esignHint')}</p>
      </section>
      {!ro && <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={!dsc || !lic || (aiTurningOn && !aiAck) || save.isPending}>{t('common.save')}</button>
        <button type="button" className="btn" onClick={() => runNow.mutate()} disabled={runNow.isPending}>{t('p8.ps.runNow')}</button>
      </div>}
      {run && <p role="status" className="card p-2 text-sm" data-testid="run-result">{t('p8.ps.ran', { day: run.day, escalations: run.escalations, alerts: run.expiryAlerts, tasks: run.renewalTasks, pbc: run.pbcReminders, skipped: run.pbcSkipped.length })}</p>}
    </form>
  );
}
