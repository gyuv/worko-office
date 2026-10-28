import { NotFoundException } from '@nestjs/common';
import { can, clientCtx, GST_STATES, SEED_LADDER, type Action, type DocSeries, docNumber, type FollowupStep } from '@worko/domain';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, type Params, visibilityOf } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';

export type BillingModule = 'billing' | 'receipts';

/** Client-scoped rows: clients:view AND <module>:<action> on the client (D52 rule), over client alias `c`. */
export const scopeSql = (a: RequestActor, module: BillingModule, action: Action, p: Params, c = 'c') =>
  `${clientScopeSql(a, 'clients', 'view', p, c)} AND ${clientScopeSql(a, module, action, p, c)}`;

export const canClient = (a: RequestActor, module: BillingModule, action: Action, client: Record<string, unknown>) => {
  const ctx = clientCtx(visibilityOf(client));
  return can(a, 'clients', 'view', ctx) && can(a, module, action, ctx);
};

/** Client row the actor may act on for `module:action`; 404 otherwise (never confirm existence). */
export async function clientFor(tx: Tx, a: RequestActor, clientId: string, module: BillingModule, action: Action) {
  const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0];
  if (!c || !canClient(a, module, action, c)) throw new NotFoundException('Client not found');
  return c as Record<string, unknown>;
}

export type Settings = { defaultEntityId: string | null; dueDays: number; defaultGstRate: number; defaultSac: string; ladder: FollowupStep[]; terms: string | null };
export async function loadSettings(tx: Tx): Promise<Settings> {
  const s = (await tx.query('SELECT * FROM billing_settings LIMIT 1')).rows[0];
  return {
    defaultEntityId: s?.default_entity_id ?? null, dueDays: s?.due_days ?? 15, defaultGstRate: s ? Number(s.default_gst_rate) : 18,
    defaultSac: s?.default_sac ?? '998231', ladder: (s?.ladder?.length ? s.ladder : SEED_LADDER) as FollowupStep[], terms: s?.terms ?? null,
  };
}

/** Billing entity: explicit, else the firm default, else the oldest active entity. */
export async function entityFor(tx: Tx, entityId: string | null | undefined) {
  const id = entityId ?? (await loadSettings(tx)).defaultEntityId;
  const e = id
    ? (await tx.query('SELECT * FROM firm_entity WHERE id = $1 AND deleted_at IS NULL AND active', [id])).rows[0]
    : (await tx.query('SELECT * FROM firm_entity WHERE deleted_at IS NULL AND active ORDER BY id LIMIT 1')).rows[0];
  if (!e) throw new NotFoundException('Billing entity not found');
  return e as Record<string, unknown>;
}

/**
 * Next number in an entity × series × FY series. The counter row is locked until the caller's transaction ends, so
 * concurrent issues serialise and a rolled-back issue leaves no gap (D66).
 */
export async function nextDocNumber(tx: Tx, tenantId: string, entity: Record<string, unknown>, series: DocSeries, fy: number): Promise<string> {
  const r = await tx.query(
    `INSERT INTO billing_counter (tenant_id, entity_id, series, fy, next) VALUES ($1,$2,$3,$4,2)
     ON CONFLICT (tenant_id, entity_id, series, fy) DO UPDATE SET next = billing_counter.next + 1 RETURNING next - 1 AS n`, [tenantId, entity.id, series, fy]);
  return docNumber(entity.invoice_prefix as string, series, fy, r.rows[0].n as number);
}

const STATE_BY_NAME = Object.fromEntries(Object.entries(GST_STATES).map(([k, v]) => [v.toLowerCase(), k]));

/** Place of supply: the client's primary GSTIN state, else the state in its first address, else unknown (null). */
export async function placeOfSupply(tx: Tx, client: Record<string, unknown>): Promise<{ state: string | null; gstin: string | null }> {
  const g = (await tx.query(`SELECT number, state_code FROM client_registration WHERE client_id = $1 AND kind = 'GSTIN' AND deleted_at IS NULL
    ORDER BY is_primary DESC, id LIMIT 1`, [client.id])).rows[0];
  if (g) return { state: (g.state_code as string | null) ?? (g.number as string).slice(0, 2), gstin: g.number };
  const addr = ((client.addresses ?? []) as Array<{ state?: string; stateCode?: string }>)[0];
  const code = addr?.stateCode ?? (addr?.state ? STATE_BY_NAME[addr.state.toLowerCase()] : undefined);
  return { state: code ?? null, gstin: null };
}

export const billTo = (c: Record<string, unknown>) => {
  const addr = ((c.addresses ?? []) as Array<Record<string, string>>)[0];
  return { name: c.name, address: addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.pin].filter(Boolean).join(', ') : null, state: addr?.state ?? null };
};

/** Date column → 'yyyy-mm-dd' (pg returns local-midnight Dates). */
export const d = (v: unknown): string | null => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : typeof v === 'string' ? v.slice(0, 10) : null);
export const n = (v: unknown) => Number(v ?? 0);
export const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const fyStart = (iso: string) => { const [y, m] = iso.split('-').map(Number) as [number, number]; return m >= 4 ? y : y - 1; };

export const presentInvoice = (r: Record<string, unknown>) => ({
  id: r.id, kind: r.kind, againstInvoiceId: r.against_invoice_id, entityId: r.entity_id, clientId: r.client_id, clientName: r.client_name ?? (r.bill_to as { name?: string })?.name,
  status: r.status, number: r.number, fy: r.fy, issueDate: d(r.issue_date), dueDate: d(r.due_date), supplyType: r.supply_type, supplierState: r.supplier_state,
  placeOfSupply: r.place_of_supply, supplierGstin: r.supplier_gstin, clientGstin: r.client_gstin, billTo: r.bill_to,
  taxablePaise: n(r.taxable_paise), cgstPaise: n(r.cgst_paise), sgstPaise: n(r.sgst_paise), igstPaise: n(r.igst_paise), reimbursementPaise: n(r.reimbursement_paise),
  roundOffPaise: n(r.round_off_paise), totalPaise: n(r.total_paise), allocatedPaise: n(r.allocated_paise), tdsPaise: n(r.tds_paise), creditedPaise: n(r.credited_paise),
  balancePaise: n(r.balance_paise), source: r.source, periodKey: r.period_key, notes: r.notes, reason: r.reason, promiseToPay: d(r.promise_to_pay),
  followupPaused: r.followup_paused, issuedAt: r.issued_at, cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, version: r.version,
});
export const presentLine = (l: Record<string, unknown>) => ({
  id: l.id, sort: l.sort, description: l.description, sac: l.sac, serviceTypeId: l.service_type_id, qty: Number(l.qty), ratePaise: n(l.rate_paise),
  discountPaise: n(l.discount_paise), gstRate: Number(l.gst_rate), reimbursement: l.reimbursement, amountPaise: n(l.amount_paise), taxablePaise: n(l.taxable_paise),
  cgstPaise: n(l.cgst_paise), sgstPaise: n(l.sgst_paise), igstPaise: n(l.igst_paise), totalPaise: n(l.total_paise), taskIds: l.task_ids ?? [],
});
export const presentReceipt = (r: Record<string, unknown>) => ({
  id: r.id, entityId: r.entity_id, clientId: r.client_id, clientName: r.client_name, number: r.number, fy: r.fy, receivedOn: d(r.received_on),
  amountPaise: n(r.amount_paise), tdsPaise: n(r.tds_paise), tdsSection: r.tds_section, mode: r.mode, reference: r.reference, notes: r.notes,
  allocatedPaise: n(r.allocated_paise), unallocatedPaise: n(r.unallocated_paise), source: r.source, version: r.version,
});
