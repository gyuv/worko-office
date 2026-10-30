import { z } from 'zod';
import { addDaysIso } from './hr.js';

/**
 * DPDP tooling (Digital Personal Data Protection Act, 2023 + DPDP Rules) — TOOLING ONLY, not legal advice.
 * Every period/retention default below is a sample value a firm must confirm — // VERIFY AGAINST OFFICIAL DOCS (see KNOWN_GAPS).
 */

export const PRINCIPAL_TYPES = ['client', 'contact', 'lead', 'portal_user', 'staff'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
export const DPDP_REQUEST_KINDS = ['access', 'correction', 'erasure', 'grievance'] as const;
export type DpdpRequestKind = (typeof DPDP_REQUEST_KINDS)[number];
export const DPDP_REQUEST_STATUSES = ['received', 'in_progress', 'completed', 'partially_completed', 'rejected'] as const;
export type DpdpRequestStatus = (typeof DPDP_REQUEST_STATUSES)[number];
export const DPDP_TRANSITIONS: Record<DpdpRequestStatus, DpdpRequestStatus[]> = {
  received: ['in_progress', 'rejected', 'completed', 'partially_completed'],
  in_progress: ['completed', 'partially_completed', 'rejected'],
  completed: [], partially_completed: [], rejected: [],
};
export const canTransitionDpdp = (from: DpdpRequestStatus, to: DpdpRequestStatus) => DPDP_TRANSITIONS[from].includes(to);

export const DATA_CATEGORIES = ['identity', 'contact', 'government_id', 'financial', 'credentials', 'communication', 'documents', 'location', 'employment'] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

/** How erasure treats a field: null it, replace with a marker, or crypto-shred (drop the ciphertext). */
export type EraseMode = 'null' | 'marker' | 'shred';
export type InventoryField = { name: string; category: DataCategory; erase: EraseMode };
export type InventoryEntry = {
  table: string; principal: PrincipalType; /** column linking rows to the principal */ key: string; purpose: string;
  retention: RetentionKey; fields: InventoryField[]; exportable: string[];
};

/** Which tables hold personal data — maintained as data (the Privacy screen renders it). */
export const DATA_INVENTORY: InventoryEntry[] = [
  { table: 'client', principal: 'client', key: 'id', purpose: 'Client master for professional services and statutory filings', retention: 'tax_records',
    fields: [
      { name: 'name', category: 'identity', erase: 'marker' }, { name: 'trade_name', category: 'identity', erase: 'null' },
      { name: 'pan', category: 'government_id', erase: 'null' }, { name: 'aadhaar_enc', category: 'government_id', erase: 'shred' },
      { name: 'aadhaar_last4', category: 'government_id', erase: 'null' }, { name: 'bank_accounts_enc', category: 'financial', erase: 'shred' },
      { name: 'dob', category: 'identity', erase: 'null' }, { name: 'email', category: 'contact', erase: 'null' }, { name: 'phone', category: 'contact', erase: 'null' },
      { name: 'addresses', category: 'contact', erase: 'null' }, { name: 'notes', category: 'communication', erase: 'null' },
    ],
    exportable: ['file_no', 'name', 'trade_name', 'entity_type', 'pan', 'email', 'phone', 'dob', 'addresses', 'status', 'created_at'] },
  { table: 'contact', principal: 'contact', key: 'id', purpose: 'People at a client the firm corresponds with', retention: 'client_relationship',
    fields: [
      { name: 'name', category: 'identity', erase: 'marker' }, { name: 'email', category: 'contact', erase: 'null' }, { name: 'phone', category: 'contact', erase: 'null' },
      { name: 'whatsapp', category: 'contact', erase: 'null' }, { name: 'dob', category: 'identity', erase: 'null' }, { name: 'anniversary', category: 'identity', erase: 'null' },
      { name: 'notes', category: 'identity', erase: 'null' },
    ],
    exportable: ['name', 'role', 'email', 'phone', 'whatsapp', 'dob', 'anniversary'] },
  { table: 'lead', principal: 'lead', key: 'id', purpose: 'Prospective client enquiries', retention: 'leads',
    fields: [
      { name: 'name', category: 'identity', erase: 'marker' }, { name: 'company', category: 'identity', erase: 'null' }, { name: 'email', category: 'contact', erase: 'null' },
      { name: 'phone', category: 'contact', erase: 'null' }, { name: 'pan', category: 'government_id', erase: 'null' }, { name: 'notes', category: 'identity', erase: 'null' },
    ],
    exportable: ['name', 'company', 'email', 'phone', 'pan', 'gstin', 'stage', 'created_at'] },
  { table: 'portal_user', principal: 'portal_user', key: 'id', purpose: 'Client portal sign-in', retention: 'client_relationship',
    fields: [{ name: 'name', category: 'identity', erase: 'marker' }, { name: 'email', category: 'contact', erase: 'null' }, { name: 'phone', category: 'contact', erase: 'null' }],
    exportable: ['name', 'email', 'phone', 'status', 'last_login_at', 'created_at'] },
  { table: 'app_user', principal: 'staff', key: 'id', purpose: 'Staff accounts, attendance and payroll inputs', retention: 'employment',
    fields: [{ name: 'name', category: 'identity', erase: 'marker' }, { name: 'email', category: 'contact', erase: 'marker' }, { name: 'phone', category: 'contact', erase: 'null' }],
    exportable: ['name', 'email', 'phone', 'status', 'created_at'] },
  { table: 'comm_message', principal: 'client', key: 'client_id', purpose: 'Messages with clients (e-mail, WhatsApp, SMS, notes)', retention: 'communications',
    fields: [{ name: 'address', category: 'contact', erase: 'null' }, { name: 'subject', category: 'communication', erase: 'null' }, { name: 'body', category: 'communication', erase: 'marker' }],
    exportable: ['channel', 'direction', 'subject', 'body', 'occurred_at'] },
  { table: 'comm_consent', principal: 'client', key: 'client_id', purpose: 'Messaging consent records (kept as proof of consent/withdrawal)', retention: 'consent_records',
    fields: [{ name: 'address', category: 'contact', erase: 'marker' }], exportable: ['channel', 'status', 'opted_in_at', 'opted_out_at'] },
  { table: 'document', principal: 'client', key: 'client_id', purpose: 'Client documents (returns, statements, KYC)', retention: 'tax_records',
    fields: [{ name: 'extracted_text', category: 'documents', erase: 'null' }], exportable: ['name', 'category', 'fy', 'created_at'] },
  { table: 'invoice', principal: 'client', key: 'client_id', purpose: 'Tax invoices (accounting records)', retention: 'tax_records',
    fields: [{ name: 'bill_to', category: 'identity', erase: 'marker' }], exportable: ['number', 'issue_date', 'total_paise', 'status'] },
  { table: 'receipt', principal: 'client', key: 'client_id', purpose: 'Payments received (accounting records)', retention: 'tax_records',
    fields: [{ name: 'reference', category: 'financial', erase: 'null' }], exportable: ['number', 'received_on', 'amount_paise', 'mode'] },
];

// ---------------- Retention ----------------

export const RETENTION_KEYS = ['tax_records', 'client_relationship', 'communications', 'consent_records', 'leads', 'employment', 'auth_logs', 'otp', 'privacy_exports'] as const;
export type RetentionKey = (typeof RETENTION_KEYS)[number];
export type RetentionRule = { key: RetentionKey; days: number; /** records under a statutory hold can't be erased inside the period */ legalHold: boolean; minDays: number; basis: string; purgeable: boolean };

/** Sample defaults — UNVERIFIED legal interpretation; firms confirm with their advisers. // VERIFY AGAINST OFFICIAL DOCS */
export const DEFAULT_RETENTION: Record<RetentionKey, RetentionRule> = {
  tax_records: { key: 'tax_records', days: 8 * 365, legalHold: true, minDays: 8 * 365, basis: 'Books/tax records retention under tax laws (sample: 8 years — VERIFY)', purgeable: false },
  client_relationship: { key: 'client_relationship', days: 3 * 365, legalHold: false, minDays: 0, basis: 'Firm policy (sample)', purgeable: false },
  communications: { key: 'communications', days: 3 * 365, legalHold: false, minDays: 0, basis: 'Firm policy (sample)', purgeable: true },
  consent_records: { key: 'consent_records', days: 7 * 365, legalHold: true, minDays: 0, basis: 'Proof of consent / withdrawal (sample — VERIFY)', purgeable: false },
  leads: { key: 'leads', days: 2 * 365, legalHold: false, minDays: 0, basis: 'Firm policy for lost/unconverted leads (sample)', purgeable: true },
  employment: { key: 'employment', days: 8 * 365, legalHold: true, minDays: 0, basis: 'Employment/payroll records (sample — VERIFY)', purgeable: false },
  auth_logs: { key: 'auth_logs', days: 365, legalHold: false, minDays: 0, basis: 'Security logs (sample — VERIFY CERT-In directions); not purged automatically yet', purgeable: false },
  otp: { key: 'otp', days: 30, legalHold: false, minDays: 0, basis: 'One-time codes (operational)', purgeable: true },
  privacy_exports: { key: 'privacy_exports', days: 30, legalHold: false, minDays: 0, basis: 'Access-request export bundles', purgeable: true },
};

export const retentionPolicySchema = z.object({ days: z.number().int().min(1).max(36500) }).strict();

/** Firm overrides on top of defaults; a statutory minimum can't be shortened. */
export function effectiveRetention(overrides: Partial<Record<RetentionKey, { days: number }>>): Record<RetentionKey, RetentionRule> {
  const out = { ...DEFAULT_RETENTION };
  for (const k of RETENTION_KEYS) {
    const o = overrides[k];
    if (o) out[k] = { ...out[k], days: Math.max(o.days, out[k].minDays) };
  }
  return out;
}
export function validateRetentionOverride(key: RetentionKey, days: number): string | null {
  const r = DEFAULT_RETENTION[key];
  return days < r.minDays ? `${key} must be kept at least ${r.minDays} days (statutory minimum in the rule table)` : null;
}

/** Cut-off date: rows last touched before it are past retention. */
export const retentionCutoff = (today: string, days: number) => addDaysIso(today, -days);

// ---------------- Erasure planning ----------------

export type ErasureStep = { table: string; fields: InventoryField[]; action: 'anonymise' | 'retain'; reason: string };
export type ErasureFacts = { /** latest date of an accounting record (invoice/receipt) for this principal, if any */ lastAccountingDate: string | null; today: string; isActiveStaff?: boolean };

/**
 * What erasure may do for a principal: anonymise PII fields, except where a legal retention hold still runs
 * (tax/accounting records, consent proofs, employment records) — those are retained with a reason. Accounting rows
 * (invoices/receipts) are never modified.
 */
export function planErasure(principal: PrincipalType, facts: ErasureFacts, rules: Record<RetentionKey, RetentionRule> = DEFAULT_RETENTION): { steps: ErasureStep[]; outcome: 'full' | 'partial' | 'blocked' } {
  const steps: ErasureStep[] = [];
  for (const e of DATA_INVENTORY.filter((x) => x.principal === principal)) {
    const rule = rules[e.retention];
    if (e.table === 'invoice' || e.table === 'receipt') { steps.push({ table: e.table, fields: e.fields, action: 'retain', reason: `legal_hold:${e.retention}` }); continue; }
    if (principal === 'staff' && facts.isActiveStaff) { steps.push({ table: e.table, fields: e.fields, action: 'retain', reason: 'active_staff_account' }); continue; }
    if (rule.legalHold && e.retention === 'tax_records' && facts.lastAccountingDate) {
      const until = addDaysIso(facts.lastAccountingDate, rule.days);
      if (until > facts.today) {
        // Tax records hold: keep identity needed for the records; still drop contact data and shred secrets not needed for them.
        const keep = e.fields.filter((f) => f.category === 'identity' || (f.category === 'government_id' && f.erase !== 'shred'));
        const drop = e.fields.filter((f) => !keep.includes(f));
        if (keep.length) steps.push({ table: e.table, fields: keep, action: 'retain', reason: `legal_hold:${e.retention}:until:${until}` });
        if (drop.length) steps.push({ table: e.table, fields: drop, action: 'anonymise', reason: 'not_needed_for_retained_records' });
        continue;
      }
    }
    if (rule.legalHold && e.retention !== 'tax_records') { steps.push({ table: e.table, fields: e.fields, action: 'retain', reason: `legal_hold:${e.retention}` }); continue; }
    steps.push({ table: e.table, fields: e.fields, action: 'anonymise', reason: 'erasure_request' });
  }
  const anon = steps.filter((s) => s.action === 'anonymise').length; const kept = steps.filter((s) => s.action === 'retain').length;
  return { steps, outcome: anon === 0 ? 'blocked' : kept === 0 ? 'full' : 'partial' };
}

export const ERASED_MARKER = '[erased]';

// ---------------- SLA ----------------

export const dpdpSettingsSchema = z.object({
  /** days to respond per request kind (sample defaults — VERIFY AGAINST OFFICIAL DOCS) */
  slaDays: z.object({ access: z.number().int().min(1).max(180), correction: z.number().int().min(1).max(180), erasure: z.number().int().min(1).max(180), grievance: z.number().int().min(1).max(180) }).strict(),
  /** hours to report a breach to the Board after becoming aware (sample — VERIFY) */
  breachReportHours: z.number().int().min(1).max(720),
  exportLinkDays: z.number().int().min(1).max(30),
  grievanceOfficer: z.object({ name: z.string().max(120), email: z.string().max(200) }).partial().strict().optional(),
}).strict();
export type DpdpSettings = z.infer<typeof dpdpSettingsSchema>;
export const DEFAULT_DPDP_SETTINGS: DpdpSettings = { slaDays: { access: 30, correction: 30, erasure: 30, grievance: 30 }, breachReportHours: 72, exportLinkDays: 7 };

export const dpdpDueDate = (receivedOn: string, kind: DpdpRequestKind, s: DpdpSettings = DEFAULT_DPDP_SETTINGS) => addDaysIso(receivedOn, s.slaDays[kind]);
export function dpdpSlaState(dueOn: string, today: string, closed: boolean): 'closed' | 'on_track' | 'due_soon' | 'overdue' {
  if (closed) return 'closed';
  if (today > dueOn) return 'overdue';
  return addDaysIso(today, 5) >= dueOn ? 'due_soon' : 'on_track';
}
export const breachReportDue = (awareAt: Date, s: DpdpSettings = DEFAULT_DPDP_SETTINGS) => new Date(awareAt.getTime() + s.breachReportHours * 3_600_000);
