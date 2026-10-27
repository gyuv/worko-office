import { useT } from '../../lib/i18n';
import { RegisterList } from './RegisterList';

export function RegistersScreen() {
  const t = useT();
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('nav.registers')}</h1>
      <RegisterList filters />
    </div>
  );
}
