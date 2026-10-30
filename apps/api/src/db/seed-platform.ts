import { addDaysIso, DEFAULT_DPDP_SETTINGS, dpdpDueDate, nextPeriod, saasInvoiceTotals, breachReportDue } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import { KeyService, LocalKms } from '../crypto/key.service.js';
import { PlatformAuditService } from '../platform/platform-audit.service.js';
import { createPlatformAdmin } from '../platform/platform-auth.service.js';
import type { DbService } from './db.service.js';
import { uuidv7 } from './ids.js';

/** Dev-only platform operator. The TOTP secret is fixed so the README/seed output can show it; NEVER use in production. */
export const PLATFORM_DEMO = { email: 'ops@platform.worko.in', name: 'Worko Ops (demo)', password: 'Platform@12345', totpSecretHex: '576f726b6f44656d6f506c6174666f726d4f7073' } as const;

/**
 * Phase 12 A demo data: a platform admin, the demo firm on Professional (trial ended → first invoice paid → active),
 * two months of usage, one DPDP access request and one breach record.
 */
export async function seedPlatform(db: DbService, tenantId: string, today: string) {
  const audit = new AuditService(); const keys = new KeyService(new LocalKms());
  const admin = await db.systemTx(async (tx) => {
    if ((await tx.query('SELECT 1 FROM platform_admin WHERE email = $1', [PLATFORM_DEMO.email])).rowCount) return null;
    return createPlatformAdmin(tx, { email: PLATFORM_DEMO.email, name: PLATFORM_DEMO.name, password: PLATFORM_DEMO.password, secret: Buffer.from(PLATFORM_DEMO.totpSecretHex, 'hex') });
  });
  const trialEnd = addDaysIso(today, -15);
  const period = nextPeriod(addDaysIso(trialEnd, 1), 'monthly');
  const supplier = (await db.systemTx((tx) => tx.query(`SELECT value FROM platform_setting WHERE key = 'saas.supplier'`))).rows[0].value;
  const price = Number((await db.systemTx((tx) => tx.query(`SELECT price_paise FROM saas_plan_price WHERE plan_key = 'professional' AND cycle = 'monthly' AND effective_from <= $1 ORDER BY effective_from DESC LIMIT 1`, [period.start]))).rows[0].price_paise);
  const seq = (await db.systemTx((tx) => tx.query(`INSERT INTO saas_invoice_counter (fy, last) VALUES ($1, 1) ON CONFLICT (fy) DO UPDATE SET last = saas_invoice_counter.last + 1 RETURNING last`,
    [Number(period.start.slice(0, 4)) - (Number(period.start.slice(5, 7)) < 4 ? 1 : 0)]))).rows[0].last as number;
  await db.systemTx((tx) => tx.query(`UPDATE tenant SET plan = 'professional', sub_status = 'active', billing_cycle = 'monthly', trial_ends_on = $2, period_start = $3, period_end = $4 WHERE id = $1`,
    [tenantId, trialEnd, period.start, period.end]));
  await db.tenantTx(tenantId, async (tx) => {
    const partner = (await tx.query(`SELECT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id WHERE r.key = 'partner' ORDER BY u.id LIMIT 1`)).rows[0].id as string;
    const firm = (await tx.query(`SELECT e.name, e.gstin, e.state_code, e.address FROM firm_entity e ORDER BY e.id LIMIT 1`)).rows[0];
    const tot = saasInvoiceTotals(price, supplier, firm.state_code, supplier.gstRate);
    const fy = Number(period.start.slice(0, 4)) - (Number(period.start.slice(5, 7)) < 4 ? 1 : 0);
    const invId = uuidv7();
    await tx.query(`INSERT INTO saas_invoice (id, tenant_id, number, issue_date, due_date, period_start, period_end, plan_key, cycle, supply_type, supplier, bill_to,
        taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, status, paid_at, provider, provider_payment_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'professional','monthly',$8,$9,$10,$11,$12,$13,$14,$15,$16,'paid',$17,'mock','pay_demo_1')`,
      [invId, tenantId, `${supplier.invoicePrefix}/${String(fy).slice(2)}${String(fy + 1).slice(2)}/${String(seq).padStart(5, '0')}`, period.start, addDaysIso(period.start, 7), period.start, period.end,
        tot.supplyType, JSON.stringify(supplier), JSON.stringify({ name: 'Sharma & Mehta, Chartered Accountants', entity: firm.name, gstin: firm.gstin, stateCode: firm.state_code, address: firm.address }),
        tot.taxablePaise, tot.cgstPaise, tot.sgstPaise, tot.igstPaise, tot.roundOffPaise, tot.totalPaise, new Date(`${addDaysIso(period.start, 2)}T11:00:00+05:30`)]);
    await audit.record(tx, tenantId, { actorId: null, deviceId: 'seed', action: 'subscription.invoice_paid', entity: 'saas_invoice', entityId: invId, diff: { totalPaise: tot.totalPaise } });
    const counts = (await tx.query(`SELECT (SELECT count(*)::int FROM app_user WHERE kind IN ('staff','freelancer') AND status = 'active') AS seats,
      (SELECT count(*)::int FROM portal_user WHERE status IN ('invited','active')) AS portal, (SELECT coalesce(sum(size),0)::bigint FROM document) AS storage,
      (SELECT count(*)::int FROM comm_message WHERE direction = 'out') AS messages, (SELECT count(*)::int FROM ai_usage) AS ai, (SELECT coalesce(sum(cost_paise),0)::bigint FROM ai_usage) AS ai_cost`)).rows[0];
    const thisMonth = today.slice(0, 7); const lastMonth = addDaysIso(`${thisMonth}-01`, -1).slice(0, 7);
    for (const [month, f] of [[lastMonth, 0.6], [thisMonth, 1]] as const) {
      await tx.query(`INSERT INTO saas_usage (id, tenant_id, month, seats, portal_users, storage_bytes, messages, ai_calls, ai_cost_paise, computed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
        [uuidv7(), tenantId, month, counts.seats, counts.portal, Math.round(Number(counts.storage) * f), Math.round(counts.messages * f), Math.round(counts.ai * f), Math.round(Number(counts.ai_cost) * f)]);
    }
    // DPDP: one open access request (client), one breach record.
    const client = (await tx.query(`SELECT id FROM client WHERE deleted_at IS NULL AND NOT sensitive ORDER BY file_no LIMIT 1`)).rows[0].id as string;
    const reqId = uuidv7(); const received = addDaysIso(today, -6);
    await tx.query(`INSERT INTO dpdp_request (id, tenant_id, kind, principal_type, principal_id, source, details_enc, received_on, due_on, created_by)
      VALUES ($1,$2,'access','client',$3,'staff',$4,$5,$6,$7)`,
      [reqId, tenantId, client, await keys.encrypt(tx, tenantId, 'Client asked by e-mail for a copy of the personal data we hold (demo).', `dpdp_request:${reqId}:details`), received, dpdpDueDate(received, 'access', DEFAULT_DPDP_SETTINGS), partner]);
    await audit.record(tx, tenantId, { actorId: partner, deviceId: 'seed', action: 'dpdp.request_received', entity: 'dpdp_request', entityId: reqId, diff: { kind: 'access', principalType: 'client', principalId: client, source: 'staff' } });
    const bId = uuidv7(); const aware = new Date(`${addDaysIso(today, -20)}T16:30:00+05:30`);
    await tx.query(`INSERT INTO dpdp_breach (id, tenant_id, title, description_enc, severity, occurred_at, aware_at, report_due_at, affected_count, data_categories, status, board_notified_at, principals_notified_at, principals_notified_count, created_by)
      VALUES ($1,$2,'Misdirected e-mail with a client''s ITR acknowledgement',$3,'low',$4,$4,$5,1,'{identity,financial}','closed',$6,$6,1,$7)`,
      [bId, tenantId, await keys.encrypt(tx, tenantId, 'An ITR-V was e-mailed to the wrong address; recipient confirmed deletion (demo).', `dpdp_breach:${bId}:description`), aware, breachReportDue(aware), new Date(aware.getTime() + 20 * 3_600_000), partner]);
    await audit.record(tx, tenantId, { actorId: partner, deviceId: 'seed', action: 'dpdp.breach_recorded', entity: 'dpdp_breach', entityId: bId, diff: { severity: 'low', affectedCount: 1 } });
  });
  if (admin) {
    await new PlatformAuditService(db).record({ adminId: admin.id, action: 'platform.admin_created', entity: 'platform_admin', entityId: admin.id, diff: { via: 'seed' } });
  }
  return { admin };
}
