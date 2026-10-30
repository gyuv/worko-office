import { isValidCidr, MODULES, type Module } from '@worko/domain';

/** Groups `module:action` scopes by module (in the permission matrix's module order) for the picker. */
export function groupScopes(scopes: string[]): Array<{ module: Module; actions: string[] }> {
  const by = new Map<string, string[]>();
  for (const s of scopes) { const [m, a] = s.split(':'); if (m && a) by.set(m, [...(by.get(m) ?? []), a]); }
  return MODULES.filter((m) => by.has(m)).map((m) => ({ module: m, actions: by.get(m)! }));
}

/** Parses the allow-list textarea (comma / newline separated); returns invalid entries separately. */
export function parseCidrs(text: string): { cidrs: string[]; invalid: string[] } {
  const parts = text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return { cidrs: parts.filter(isValidCidr), invalid: parts.filter((p) => !isValidCidr(p)) };
}

/** Read-mostly preset matching the public API surface (D191). */
export const PUBLIC_API_PRESET = ['clients:view', 'tasks:view', 'billing:view', 'documents:view', 'compliance:view', 'time:view'];

export type DeliveryStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'skipped';
export const deliveryTone = (s: DeliveryStatus) => (s === 'succeeded' ? 'text-done' : s === 'failed' ? 'text-overdue' : s === 'retrying' ? 'text-due-soon' : 'text-muted');

/** datetime-local (IST wall clock) → ISO with +05:30, or null when empty. */
export const expiryIso = (local: string) => (local ? `${local.length === 16 ? `${local}:00` : local}+05:30` : null);
