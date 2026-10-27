import { ENTITY_TYPES, type EntityType } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { useT } from '../../lib/i18n';

export const entityKey = (e: string): MessageKey => (ENTITY_TYPES.includes(e as EntityType) ? `entity.${e as EntityType}` : 'entity.OTHER');
export function useEntityLabel() {
  const t = useT();
  return (e: string) => t(entityKey(e));
}
