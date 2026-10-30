import { formatDateTime } from '@worko/i18n';
import { useT } from '../lib/i18n';
import { useMe } from '../lib/me';
import { useSession } from '../lib/session';

export const IMPERSONATION_KEY = 'worko.impersonation';
/** `#/platform` (and sub-paths) opens the super-admin console instead of the firm app. */
export const isPlatformHash = (hash: string) => /^#\/platform(\/|$|\?)/.test(hash);

/** Always-visible banner while Worko support is inside the firm (impersonation token; D180). */
export function ImpersonationBanner() {
  const t = useT();
  const imp = useMe().data?.impersonation;
  if (!imp) return null;
  const end = () => {
    try { sessionStorage.removeItem(IMPERSONATION_KEY); } catch { /* ignore */ }
    useSession.getState().setTokens(null);
    location.hash = '#/platform';
  };
  return (
    <div role="alert" data-testid="impersonation-banner" className="sticky top-0 z-50 flex flex-wrap items-center gap-2 border-b border-overdue bg-surface-alt px-3 py-2 text-sm text-overdue">
      <span>{t('p12a.banner', { mode: t(imp.write ? 'p12a.imp.write' : 'p12a.imp.read'), until: formatDateTime(imp.expiresAt) })}</span>
      <button className="btn ml-auto" onClick={end}>{t('p12a.banner.end')}</button>
    </div>
  );
}
