import { PRODUCT } from '@worko/domain';
import { createTranslator } from '@worko/i18n';
import type { LocalRow } from '@worko/sync';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { getStore, useSync } from './sync';
import { TOUCH } from './logic/layout';
import type { Theme } from './theme';

export const t = createTranslator('en-IN', { product: PRODUCT.name });

/** Rows of a synced table from the local (encrypted) store; re-reads whenever sync touches the table. */
export function useTable(table: string): LocalRow[] {
  const v = useSync((x) => x.versions[table] ?? 0);
  const [rows, setRows] = useState<LocalRow[]>([]);
  useEffect(() => {
    let live = true;
    void getStore()?.list(table).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [table, v]);
  return rows;
}

export const ui = (th: Theme) => StyleSheet.create({
  h1: { fontSize: 20, fontWeight: '600', color: th.text },
  h2: { fontSize: 16, fontWeight: '600', color: th.text, marginTop: 16, marginBottom: 6 },
  text: { fontSize: 15, color: th.text },
  muted: { fontSize: 13, color: th.textMuted },
  label: { fontSize: 13, color: th.textMuted, marginTop: 12, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: th.border, backgroundColor: th.surface, color: th.text, borderRadius: 6, paddingHorizontal: 12, minHeight: TOUCH, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: th.border },
  button: { minHeight: TOUCH, backgroundColor: th.primary, borderRadius: 6, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  buttonText: { color: th.primaryText, fontWeight: '600', fontSize: 15 },
  ghost: { minHeight: TOUCH, minWidth: TOUCH, borderRadius: 6, borderWidth: 1, borderColor: th.border, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  ghostText: { color: th.primary, fontWeight: '600', fontSize: 14 },
  icon: { minHeight: TOUCH, minWidth: TOUCH, alignItems: 'center', justifyContent: 'center' },
  chip: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: th.surfaceAlt, overflow: 'hidden', fontSize: 12, color: th.text },
  chipBtn: { minHeight: 40, borderRadius: 20, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 1, borderColor: th.border },
  alert: { marginTop: 8, padding: 10, borderRadius: 6, backgroundColor: th.surfaceAlt, color: th.text },
});
