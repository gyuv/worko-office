import { createTranslator, type Locale, type Translate } from '@worko/i18n';
import { PRODUCT } from '@worko/domain';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

const Ctx = createContext<Translate>(createTranslator('en-IN', { product: PRODUCT.name }));

export function I18nProvider({ locale = 'en-IN', children }: { locale?: Locale; children: ReactNode }) {
  const t = useMemo(() => createTranslator(locale, { product: PRODUCT.name }), [locale]);
  return <Ctx.Provider value={t}>{children}</Ctx.Provider>;
}
export const useT = () => useContext(Ctx);
