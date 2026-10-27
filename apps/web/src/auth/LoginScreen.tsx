import { useState, type FormEvent } from 'react';
import { api, unwrap, useSession } from '../lib/session';
import { useT } from '../lib/i18n';
import { platformName } from '../lib/platform';
import type { MessageKey } from '@worko/i18n';

type Mode = 'password' | 'otp';

export function LoginScreen() {
  const t = useT();
  const setTokens = useSession((s) => s.setTokens);
  const notice = useSession((s) => s.notice);
  const [mode, setMode] = useState<Mode>('password');
  const [firm, setFirm] = useState(() => localStorage.getItem('worko.lastFirm') ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const device = { platform: platformName(), label: navigator.userAgent.includes('Windows') ? 'Windows PC' : 'Browser' } as const;

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) {
      const err = e as { status?: number; code?: string };
      if (err.code === 'MFA_REQUIRED') { setNeedTotp(true); setError('auth.mfaRequired'); }
      else setError(err.status === 429 ? 'auth.locked' : err.status && err.status < 500 ? 'auth.invalid' : 'common.error');
    } finally { setBusy(false); }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    localStorage.setItem('worko.lastFirm', firm);
    if (mode === 'password') {
      void run(async () => setTokens(await unwrap(api.POST('/auth/login', { body: { firm, email, password, totp: totp || undefined, device } }))));
    } else if (!otpSent) {
      void run(async () => { await unwrap(api.POST('/auth/otp/request', { body: { firm, phone } })); setOtpSent(true); });
    } else {
      void run(async () => setTokens(await unwrap(api.POST('/auth/otp/verify', { body: { firm, phone, code: otp, device } }))));
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6" aria-labelledby="login-title">
        <div>
          <div className="text-2xl font-semibold">{t('app.name')}</div>
          <h1 id="login-title" className="text-muted">{t('auth.title')}</h1>
        </div>
        {notice === 'wiped' && !error && <div role="alert" className="rounded-md border border-border bg-surface-alt p-2 text-sm">{t('auth.wiped')}</div>}
        {error && <div role="alert" className="rounded-md border border-border bg-surface-alt p-2 text-sm">{t(error)}</div>}
        <Field id="firm" label={t('auth.firm')} value={firm} onChange={setFirm} placeholder={t('auth.firmHint')} autoComplete="organization" />
        {mode === 'password' ? (
          <>
            <Field id="email" type="email" label={t('auth.email')} value={email} onChange={setEmail} autoComplete="username" />
            <Field id="password" type="password" label={t('auth.password')} value={password} onChange={setPassword} autoComplete="current-password" />
            {needTotp && <Field id="totp" label={t('auth.totp')} value={totp} onChange={setTotp} inputMode="numeric" autoComplete="one-time-code" autoFocus />}
          </>
        ) : (
          <>
            <Field id="phone" type="tel" label={t('auth.phone')} value={phone} onChange={setPhone} autoComplete="tel" placeholder="+91" />
            {otpSent && <Field id="otp" label={t('auth.otp')} value={otp} onChange={setOtp} inputMode="numeric" autoComplete="one-time-code" autoFocus />}
          </>
        )}
        <button className="btn btn-primary w-full justify-center" disabled={busy}>
          {mode === 'otp' && !otpSent ? t('auth.sendOtp') : t('auth.signIn')}
        </button>
        <button type="button" className="w-full text-center text-sm text-primary" onClick={() => { setMode(mode === 'password' ? 'otp' : 'password'); setError(null); }}>
          {mode === 'password' ? t('auth.usePhone') : t('auth.useEmail')}
        </button>
      </form>
    </main>
  );
}

function Field(p: { id: string; label: string; value: string; onChange(v: string): void; type?: string; placeholder?: string; autoComplete?: string; inputMode?: 'numeric'; autoFocus?: boolean }) {
  return (
    <div>
      <label htmlFor={p.id} className="label">{p.label}</label>
      <input id={p.id} className="input" type={p.type ?? 'text'} value={p.value} placeholder={p.placeholder} required
        autoComplete={p.autoComplete} inputMode={p.inputMode} autoFocus={p.autoFocus} onChange={(e) => p.onChange(e.target.value)} />
    </div>
  );
}
