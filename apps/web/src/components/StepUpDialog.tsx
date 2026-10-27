import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '../lib/i18n';
import { useMe } from '../lib/me';
import { api, unwrap } from '../lib/session';
import { finishStepUp, useStepUp } from '../lib/stepup';
import { Dialog, Field } from './Dialog';

/** Re-authentication prompt for sensitive actions (reveal Aadhaar/bank/credentials). Opens a 5-minute window. */
export function StepUpDialog() {
  const open = useStepUp((s) => s.open);
  return open ? <StepUpForm /> : null;
}

function StepUpForm() {
  const t = useT();
  const totp = !!useMe().data?.totpEnabled;
  const [value, setValue] = useState('');
  const go = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/step-up', { body: totp ? { totp: value } : { password: value } })),
    onSuccess: () => finishStepUp(true),
  });
  return (
    <Dialog title={t('stepup.title')} onClose={() => finishStepUp(false)}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        <p className="text-muted">{t('stepup.help')}</p>
        {totp
          ? <Field label={t('auth.totp')}><input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} /></Field>
          : <Field label={t('auth.password')}><input className="input" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} /></Field>}
        {go.isError && <p role="alert" className="text-overdue">{t('auth.invalid')}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => finishStepUp(false)}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!value || go.isPending}>{t('stepup.confirm')}</button>
        </div>
      </form>
    </Dialog>
  );
}
