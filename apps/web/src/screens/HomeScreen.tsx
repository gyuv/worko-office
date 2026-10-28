import { useT } from '../lib/i18n';
import { useMe } from '../lib/me';

export function HomeScreen() {
  const t = useT();
  const me = useMe().data;
  const h = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const partOfDay = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('home.greeting', { partOfDay, name: me?.name.split(' ')[0] ?? '' })}</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4"><div className="label">{t('home.firm')}</div><div className="text-lg">{me?.firmName}</div><div className="text-muted">{me?.firmSlug}</div></div>
        <div className="card p-4"><div className="label">{t('home.roles')}</div><div className="text-lg capitalize">{me?.roles.join(', ')}</div></div>
      </div>
    </div>
  );
}

export function ComingSoon({ module, phase }: { module: string; phase: number }) {
  const t = useT();
  return <div className="card p-6 text-muted">{t('home.comingSoon', { module, phase })}</div>;
}
