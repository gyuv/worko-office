import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useT } from '../lib/i18n';
import { api, unwrap } from '../lib/session';

export function TeamScreen() {
  const t = useT();
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')) });
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('nav.team')}</h1>
      <div className="card overflow-auto">
        <table className="table w-full">
          <thead><tr><th>Name</th><th>{t('auth.email')}</th><th>{t('home.roles')}</th><th>{t('security.twoFactor')}</th></tr></thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td className="font-medium">{u.name}</td><td>{u.email}</td><td className="capitalize">{u.roles.join(', ')}</td>
                <td>{u.totpEnabled ? <ShieldCheck size={16} className="text-done" aria-label={t('security.twoFactorOn')} /> : <span className="text-muted">{t('security.twoFactorOff')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
