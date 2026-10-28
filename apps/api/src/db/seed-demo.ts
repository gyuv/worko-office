import { fileURLToPath } from 'node:url';
import { gstinCheckChar, type EntityType } from '@worko/domain';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { KeyService, LocalKms } from '../crypto/key.service.js';
import { LocalStorage } from '../storage/storage.js';
import { hint } from '../vault/vault.service.js';
import type { Tx } from './db.service.js';
import { hashPassword } from '../auth/crypto.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { DbService } from './db.service.js';
import { uuidv7 } from './ids.js';
import { migrate } from './migrate.js';
import { RulesService } from '../rules/rules.service.js';
import { RulePackService } from '../compliance/rule-pack.service.js';
import { CatalogueService } from '../tasks/catalogue.service.js';
import { AutoTaskService } from '../tasks/auto.service.js';
import { systemActor } from '../tasks/system-actor.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { SYNC_TABLES } from '../sync/registry.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { todayIst } from '../compliance/facts.js';
import { dates } from '@worko/rules';
import { SEED_LADDER } from '@worko/domain';
import { BillingAutoService } from '../billing/auto.service.js';
import { InvoicesService } from '../billing/invoices.service.js';
import { Clock } from '../common/clock.js';
import { ReceiptsService } from '../billing/receipts.service.js';
import { seedHr } from './seed-hr.js';

export const DEMO = { firm: 'demo', password: 'Demo@12345', users: [
  { name: 'Anita Sharma', email: 'partner@demo.worko.in', role: 'partner', phone: '+919800000001' },
  { name: 'Rahul Mehta', email: 'manager@demo.worko.in', role: 'manager', phone: '+919800000002' },
  { name: 'Priya Iyer', email: 'senior@demo.worko.in', role: 'senior', phone: '+919800000003' },
  { name: 'Karan Patel', email: 'article@demo.worko.in', role: 'article', phone: '+919800000004' },
  { name: 'Meena Joshi', email: 'accounts@demo.worko.in', role: 'accountant', phone: '+919800000005' },
] } as const;

/**
 * Demo firm for local development and screenshots. Re-runnable: drops nothing, skips if the firm exists.
 * Clients, tasks, invoices, DSCs and notices are added by later phases as their modules land.
 */
export async function seedDemo(url: string, opts: { today?: string } = {}) {
  // Reference date for "current" tasks/registers; tests pin it so the seed is identical on every run.
  const today = opts.today ?? todayIst();
  await migrate(url);
  process.env.DATABASE_URL = url;
  const db = new DbService();
  try {
    const exists = await db.systemTx((tx) => tx.query("SELECT id FROM tenant WHERE slug = $1", [DEMO.firm]));
    if (exists.rowCount) return { created: false };
    const [partner, ...rest] = DEMO.users;
    const { tenantId } = await new TenancyService(db, new AuditService()).signup({
      firmName: 'Sharma & Mehta, Chartered Accountants', slug: DEMO.firm, stateCode: '27',
      partner: { name: partner.name, email: partner.email, password: DEMO.password, phone: partner.phone },
    });
    const hash = await hashPassword(DEMO.password);
    await db.tenantTx(tenantId, async (tx) => {
      const branch = (await tx.query('SELECT id FROM branch LIMIT 1')).rows[0].id;
      await tx.query("INSERT INTO branch (id, tenant_id, name, state_code) VALUES ($1,$2,'Pune branch','27')", [uuidv7(), tenantId]);
      const userIds: Record<string, string> = { partner: (await tx.query('SELECT id FROM app_user LIMIT 1')).rows[0].id };
      for (const u of rest) {
        const id = uuidv7();
        userIds[u.role] = id;
        await tx.query('INSERT INTO app_user (id, tenant_id, email, phone, name, password_hash, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, tenantId, u.email, u.phone, u.name, hash, branch]);
        await tx.query('INSERT INTO user_role (tenant_id, user_id, role_id) SELECT $1, $2, id FROM role WHERE key = $3', [tenantId, id, u.role]);
      }
      await tx.query('UPDATE app_user SET manager_id = $1 WHERE id = ANY($2)', [userIds.manager, [userIds.senior, userIds.article]]);
      await seedPractice(tx, tenantId, branch, userIds, today);
      await seedTasks(db, tx, tenantId, userIds, today);
    });
    await seedBilling(db, tenantId, today);
    await seedHr(db, tenantId, today);
    return { created: true, tenantId };
  } finally {
    await db.pool.end();
  }
}

/** Deterministic PRNG so the demo firm is identical on every machine (screenshots, manuals). */
function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

const FIRST = ['Shree Ganesh', 'Laxmi', 'Sai', 'Om', 'Balaji', 'Krishna', 'Mahalaxmi', 'Siddhivinayak', 'Jai Hind', 'Navkar', 'Sahyadri', 'Kaveri', 'Ganga', 'Sunrise', 'Pragati', 'Vikas', 'Annapurna', 'Tirupati', 'Shivam', 'Ashirwad'];
const LAST = ['Traders', 'Enterprises', 'Industries', 'Agencies', 'Steels', 'Textiles', 'Pharma', 'Foods', 'Constructions', 'Logistics', 'Electricals', 'Plastics'];
const PEOPLE = ['Rajesh Kulkarni', 'Sunita Deshpande', 'Amit Joshi', 'Neha Patil', 'Vikram Shah', 'Pooja Mehta', 'Sanjay Gupta', 'Kavita Iyer', 'Rahul Bhosale', 'Anjali Rao', 'Manoj Jain', 'Swati Kale'];
const CITIES: Array<[string, string, string, string]> = [['Pune', 'Maharashtra', '27', '411001'], ['Mumbai', 'Maharashtra', '27', '400001'], ['Nashik', 'Maharashtra', '27', '422001'], ['Bengaluru', 'Karnataka', '29', '560001'], ['Ahmedabad', 'Gujarat', '24', '380001']];
const KINDS: Array<[EntityType, string, string]> = [['PRIVATE_COMPANY', 'C', 'Pvt Ltd'], ['PARTNERSHIP', 'F', ''], ['PROPRIETORSHIP', 'P', ''], ['LLP', 'F', 'LLP'], ['INDIVIDUAL', 'P', ''], ['HUF', 'H', 'HUF']];

/** 50 clients with groups, a GST team, GSTINs, contacts, credentials, documents and register entries. */
async function seedPractice(tx: Tx, tenantId: string, branch: string, users: Record<string, string>, today: string) {
  const r = rng(42);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const keys = new KeyService(new LocalKms());
  const storage = new LocalStorage();
  const team = uuidv7();
  await tx.query('INSERT INTO team (id, tenant_id, name, branch_id, lead_user_id) VALUES ($1,$2,$3,$4,$5)', [team, tenantId, 'GST team', branch, users.manager]);
  for (const u of [users.senior, users.article, users.manager]) await tx.query('INSERT INTO team_member (tenant_id, team_id, user_id) VALUES ($1,$2,$3)', [tenantId, team, u]);
  const groups: string[] = [];
  for (const [i, name] of ['Kulkarni family', 'Sahyadri group of companies', 'Retail cluster – Pune'].entries()) {
    const id = uuidv7();
    await tx.query('INSERT INTO client_group (id, tenant_id, name, kind) VALUES ($1,$2,$3,$4)', [id, tenantId, name, i === 0 ? 'family' : 'group']);
    groups.push(id);
  }
  await tx.query(`INSERT INTO custom_field_def (id, tenant_id, entity, key, label, type, options) VALUES ($1,$2,'client','industry','Industry','select','["Manufacturing","Trading","Services","Professional"]')`, [uuidv7(), tenantId]);
  const fy = (() => { const [y, m] = today.split('-').map(Number) as [number, number]; const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; })();
  const pdf = Buffer.from('%PDF-1.4\n% Worko demo document\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  let inward = 0;
  for (let i = 0; i < 50; i++) {
    const [entity, panChar, suffix] = pick(KINDS);
    const person = pick(PEOPLE);
    const name = entity === 'INDIVIDUAL' ? person : entity === 'HUF' ? `${person.split(' ')[1]} ${person.split(' ')[0]} HUF` : `${pick(FIRST)} ${pick(LAST)}${suffix ? ' ' + suffix : ''}`;
    const pan = `AA${String.fromCharCode(65 + (i % 26))}${panChar}${String.fromCharCode(65 + Math.floor(r() * 26))}${String(1000 + i).padStart(4, '0')}${String.fromCharCode(65 + Math.floor(r() * 26))}`;
    const [city, state, code, pin] = pick(CITIES);
    const id = uuidv7();
    const gst = entity !== 'INDIVIDUAL' && entity !== 'HUF';
    const filing = r() < 0.7 ? 'MONTHLY' : 'QRMP';
    await tx.query(`INSERT INTO client (id, tenant_id, file_no, name, entity_type, pan, email, phone, addresses, status, tags, custom, compliance_profile,
        branch_id, partner_id, manager_id, team_id, staff_ids, group_ids, sensitive, allowed_user_ids, aadhaar_enc, aadhaar_last4)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`, [
      id, tenantId, `F-${String(101 + i)}`, name, entity, pan, `accounts${i}@example.in`, `+9198${String(20000000 + i * 7919).slice(0, 8)}`,
      JSON.stringify([{ kind: 'registered', line1: `${10 + i}, ${pick(['MG Road', 'FC Road', 'Station Road', 'Market Yard', 'MIDC'])}`, city, state, pin }]),
      i < 47 ? 'active' : 'inactive', r() < 0.3 ? ['retainer'] : [], JSON.stringify({ industry: pick(['Manufacturing', 'Trading', 'Services', 'Professional']) }),
      JSON.stringify({ gstRegistered: gst, gstFiling: gst ? filing : null, hasTan: entity === 'PRIVATE_COMPANY' || entity === 'LLP', taxAudit: r() < 0.3, entityType: entity }),
      branch, users.partner, users.manager, i % 2 === 0 ? team : null, i < 12 ? [users.article] : i < 25 ? [users.senior] : [],
      i < 4 ? [groups[0]] : i < 8 ? [groups[1]] : i % 5 === 0 ? [groups[2]] : [], i === 49 || i === 48, i >= 48 ? [users.partner] : [],
      entity === 'INDIVIDUAL' ? await keys.encrypt(tx, tenantId, `98765432${String(1000 + i).slice(-4)}`, `client:${id}:aadhaar`) : null,
      entity === 'INDIVIDUAL' ? String(1000 + i).slice(-4) : null,
    ]);
    if (gst) {
      const base = `${code}${pan}1Z`;
      await tx.query(`INSERT INTO client_registration (id, tenant_id, client_id, kind, number, state_code, status, is_primary) VALUES ($1,$2,$3,'GSTIN',$4,$5,'Active',true)`,
        [uuidv7(), tenantId, id, base + gstinCheckChar(base), code]);
    }
    await tx.query(`INSERT INTO contact (id, tenant_id, client_id, name, role, phone, email, is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
      [uuidv7(), tenantId, id, person, entity === 'PRIVATE_COMPANY' ? 'Director' : 'Owner', `+9197${String(30000000 + i * 104729).slice(0, 8)}`, `${person.split(' ')[0]!.toLowerCase()}@example.in`]);
    if (i < 15) {
      for (const [portal, label, user] of [['GST', 'GST portal', `${pan.slice(0, 5).toLowerCase()}gst`], ['INCOME_TAX', 'Income-tax e-filing', pan]] as const) {
        if (portal === 'GST' && !gst) continue;
        const sid = uuidv7();
        await tx.query(`INSERT INTO vault_secret (id, tenant_id, client_id, portal, label, username_hint, username_enc, secret_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [sid, tenantId, id, portal, label, hint(user), await keys.encrypt(tx, tenantId, user, `vault:${sid}:username`),
            await keys.encrypt(tx, tenantId, `Demo#${pan.slice(-5)}`, `vault:${sid}:secret`), users.partner]);
      }
    }
    if (i < 20) {
      for (const [cat, fname] of [['ITR', 'ITR-V acknowledgement.pdf'], ['KYC', 'PAN card.pdf']] as const) {
        const did = uuidv7(); const key = `t/${tenantId}/d/${did}/v1`;
        await storage.put(key, pdf);
        const sha = createHash('sha256').update(pdf).digest('hex');
        await tx.query(`INSERT INTO document (id, tenant_id, client_id, fy, category, name, mime, size, sha256, storage_key, permanent, uploaded_by)
          VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8,$9,$10,$11)`, [did, tenantId, id, cat === 'KYC' ? null : fy, cat, fname, pdf.length, sha, key, cat === 'KYC', users.senior]);
        await tx.query(`INSERT INTO document_version (id, tenant_id, document_id, version, storage_key, size, sha256, mime, uploaded_by) VALUES ($1,$2,$3,1,$4,$5,$6,'application/pdf',$7)`,
          [uuidv7(), tenantId, did, key, pdf.length, sha, users.senior]);
      }
    }
    if (i < 10) {
      inward++;
      await tx.query(`INSERT INTO inward_entry (id, tenant_id, number, fy, client_id, received_on, mode, from_name, from_phone, description, items, returnable, due_back, received_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [uuidv7(), tenantId, `IN/${fy}/${String(inward).padStart(4, '0')}`, fy, id, today, pick(['physical', 'courier', 'whatsapp']), person, null,
          pick(['Bank statements Apr–Sep', 'Purchase invoices', 'Form 16 and salary slips', 'Original sale deed']), JSON.stringify([{ description: 'File', qty: 1, original: i % 3 === 0 }]),
          i % 3 === 0, i % 3 === 0 ? today : null, users.article]);
    }
  }
  await tx.query(`INSERT INTO register_counter (tenant_id, kind, fy, next) VALUES ($1,'IN',$2,$3)`, [tenantId, fy, inward + 1]);
}

/**
 * Phase 4: default catalogue, subscriptions (GST monthly → GSTR-1 + GSTR-3B; TAN → TDS deposit), auto-created tasks for
 * the two periods ending before `today`'s month, a spread of statuses (done/billed, review, pending, overdue), to-dos
 * and one draft due-date extension. Deterministic for a given `today`.
 */
async function seedTasks(db: DbService, tx: Tx, tenantId: string, users: Record<string, string>, today: string) {
  const audit = new AuditService(); const realtime = new RealtimeService();
  const packs = new RulePackService(new RulesService(), audit);
  const sync = new SyncService(db, audit, realtime, SYNC_TABLES);
  const sys = systemActor(tenantId);
  await new CatalogueService(db, audit, sync, realtime, packs).installDefaultsTx(tx, sys);
  await tx.query(`INSERT INTO client_service (id, tenant_id, client_id, service_type_id)
    SELECT gen_random_uuid(), c.tenant_id, c.id, s.id FROM client c JOIN service_type s ON s.key IN ('GSTR1','GSTR3B')
    WHERE c.compliance_profile->>'gstFiling' = 'MONTHLY' AND c.deleted_at IS NULL`);
  await tx.query(`INSERT INTO client_service (id, tenant_id, client_id, service_type_id)
    SELECT gen_random_uuid(), c.tenant_id, c.id, s.id FROM client c JOIN service_type s ON s.key = 'TDS_DEPOSIT'
    WHERE (c.compliance_profile->>'hasTan')::boolean AND c.deleted_at IS NULL`);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const ym = (n: number) => { const x = dates.addMonths(y, m, n); return `${x.y}-${String(x.m).padStart(2, '0')}`; };
  const auto = new AutoTaskService(db, packs, audit, realtime, new JobQueueService(db));
  const older = await auto.commitTx(tx, sys, ym(-2));
  const recent = await auto.commitTx(tx, sys, ym(-1));
  const r = rng(7);
  const tick = `(SELECT jsonb_agg(c || jsonb_build_object('done', true, 'doneBy', t.assignee_id, 'doneAt', now())) FROM jsonb_array_elements(t.checks) c)`;
  for (const id of older.ids) {
    const x = r();
    // Done tasks stay unbilled here; seedBilling invoices about two thirds of them (outcome 'billed' via the invoice link).
    if (x < 0.75) await tx.query(`UPDATE task t SET checks = ${tick}, status = 'done', completed_at = $2 WHERE id = $1`, [id, new Date(`${dates.addDays(today, -25)}T12:00:00+05:30`)]);
    // the rest stay open → overdue in the demo
  }
  for (const id of recent.ids) {
    const x = r();
    if (x < 0.2) await tx.query(`UPDATE task t SET status = 'in_progress' WHERE id = $1`, [id]);
    else if (x < 0.35) await tx.query(`UPDATE task t SET checks = ${tick}, status = 'review', reviewer_id = coalesce(reviewer_id, $2) WHERE id = $1`, [id, users.manager]);
    else if (x < 0.45) await tx.query(`UPDATE task t SET status = 'pending_client', pending_issue = 'Purchase register / bank statement awaited from client' WHERE id = $1`, [id]);
    else if (x < 0.55) await tx.query(`UPDATE task t SET checks = ${tick}, status = 'done', completed_at = $2 WHERE id = $1`, [id, new Date(`${dates.addDays(today, -3)}T12:00:00+05:30`)]);
  }
  await tx.query(`INSERT INTO task (id, tenant_id, title, description, statutory_due, act_by, assignee_id, manager_id, priority, created_by)
    VALUES ($1,$2,'Renew professional indemnity insurance','Firm task (no client)',$3,$3,$4,$4,'high',$4)`, [uuidv7(), tenantId, dates.addDays(today, 20), users.partner]);
  const todos: Array<[string, string, number]> = [[users.article!, 'Collect bank statements from Laxmi Traders', 1], [users.article!, 'Scan inward papers to client folders', 0],
    [users.senior!, 'Call client about pending GSTR-2B mismatches', 2], [users.manager!, 'Review this week\'s GSTR-3B workings', 3]];
  for (const [owner, title, d] of todos) {
    await tx.query(`INSERT INTO todo (id, tenant_id, owner_id, title, due_at) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), tenantId, owner, title, new Date(`${dates.addDays(today, d)}T18:00:00+05:30`)]);
  }
  await tx.query(`INSERT INTO todo_template (id, tenant_id, name, items) VALUES ($1,$2,'GST month-end','[{"title":"Chase sales & purchase data","offsetDays":0},{"title":"Share 3B working with client","offsetDays":12},{"title":"Confirm challan payment","offsetDays":17}]')`, [uuidv7(), tenantId]);
  // A draft extension waiting for approval (sample — not a real notification).
  const due = (await tx.query(`SELECT statutory_due::text AS d FROM task WHERE rule_id = 'gst.gstr3b.monthly' AND period_key = $1 LIMIT 1`, [ym(-1)])).rows[0]?.d as string | undefined;
  if (due) {
    await tx.query(`INSERT INTO rule_extension (id, tenant_id, rule_id, period_key, new_due_date, notification) VALUES ($1,$2,'gst.gstr3b.monthly',$3,$4,'DEMO — sample extension, not a real notification')`,
      [uuidv7(), tenantId, ym(-1), dates.addDays(due, 5)]);
  }
}

/** Indicative demo fees per service (SAMPLE DATA — firms set their own rate tables). Rupees. */
const DEMO_FEES: Record<string, number> = { GSTR3B: 1500, GSTR1: 1000, TDS_DEPOSIT: 750, TDS_RETURN: 2500, ITR: 3500, BOOKKEEPING: 5000, CONSULTATION: 3000 };

/**
 * Phase 5: two billing entities (registered in Maharashtra + a Karnataka LLP), rate tables for every service, ledger map,
 * follow-up ladder, invoices auto-drafted from the older month's done tasks and issued on dates spread across the ageing
 * buckets, a full payment, a part payment with TDS, a credit note, an advance, a retainer draft. Deterministic for `today`.
 */
async function seedBilling(db: DbService, tenantId: string, today: string) {
  const audit = new AuditService(); const realtime = new RealtimeService();
  const sync = new SyncService(db, audit, realtime, SYNC_TABLES);
  const invoices = new InvoicesService(db, audit, sync, realtime, new Clock(new Date(`${today}T18:00:00+05:30`)));
  const receipts = new ReceiptsService(db, audit, invoices, sync);
  const auto = new BillingAutoService(db, invoices, audit, new JobQueueService(db));
  const sys = systemActor(tenantId);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const ym = (k: number) => { const x = dates.addMonths(y, m, k); return `${x.y}-${String(x.m).padStart(2, '0')}`; };
  const toBill = await db.tenantTx(tenantId, async (tx) => {
    const base = '27AABFS1234K1Z'; const base2 = '29AAKFS5678L1Z';
    const e1 = (await tx.query('SELECT id FROM firm_entity ORDER BY id LIMIT 1')).rows[0].id;
    await tx.query(`UPDATE firm_entity SET gstin = $2, pan = 'AABFS1234K', frn = '123456W', invoice_prefix = 'SMA', address = '301, Shivaji Nagar, Pune 411005',
      email = 'accounts@sharmamehta.example.in', bank = $3 WHERE id = $1`,
      [e1, base + gstinCheckChar(base), JSON.stringify({ name: 'HDFC Bank', accountNo: '50100012345678', ifsc: 'HDFC0000123', branch: 'Shivaji Nagar', upiId: 'sharmamehta@hdfcbank' })]);
    await tx.query(`INSERT INTO firm_entity (id, tenant_id, name, gstin, pan, state_code, invoice_prefix, address) VALUES ($1,$2,'Sharma Mehta Advisory LLP',$3,'AAKFS5678L','29','SMK','12, MG Road, Bengaluru 560001')`,
      [uuidv7(), tenantId, base2 + gstinCheckChar(base2)]);
    await tx.query(`INSERT INTO billing_settings (tenant_id, default_entity_id, due_days, ladder, terms) VALUES ($1,$2,15,$3,'Payment within 15 days. Interest may apply on delayed payments.')`,
      [tenantId, e1, JSON.stringify(SEED_LADDER)]);
    const fy = `${m >= 4 ? y : y - 1}-04-01`;
    await tx.query(`INSERT INTO billing_rate (id, tenant_id, service_type_id, amount_paise, effective_from, notes)
      SELECT gen_random_uuid(), tenant_id, id, (COALESCE(($1::jsonb ->> key)::int, 2000) * 100), $2::date, 'Demo fee (sample)' FROM service_type WHERE deleted_at IS NULL`, [JSON.stringify(DEMO_FEES), fy]);
    for (const [k, v] of [['sales', 'Professional Fees'], ['output_cgst', 'Output CGST'], ['output_sgst', 'Output SGST'], ['output_igst', 'Output IGST'], ['round_off', 'Round Off'],
      ['reimbursement', 'Reimbursement of Expenses'], ['tds_receivable', 'TDS Receivable'], ['bank', 'HDFC Bank'], ['cash', 'Cash']]) {
      await tx.query('INSERT INTO tally_ledger_map (id, tenant_id, account_key, ledger_name) VALUES ($1,$2,$3,$4)', [uuidv7(), tenantId, k, v]);
    }
    // A monthly bookkeeping retainer for the first two active clients.
    const retain = (await tx.query(`SELECT id FROM client WHERE status = 'active' AND NOT sensitive ORDER BY file_no LIMIT 2`)).rows.map((r) => r.id);
    await tx.query(`INSERT INTO client_service (id, tenant_id, client_id, service_type_id, billing_frequency)
      SELECT gen_random_uuid(), $1, c, s.id, 'monthly' FROM unnest($2::uuid[]) c, service_type s WHERE s.key = 'BOOKKEEPING'`, [tenantId, retain]);
    // Bill two thirds of the clients that have done-unbilled tasks from the older month.
    const cs = (await tx.query(`SELECT DISTINCT t.client_id, c.file_no FROM task t JOIN client c ON c.id = t.client_id
      WHERE t.status = 'done' AND t.outcome IS NULL AND t.period_key = $1 ORDER BY c.file_no`, [ym(-2)])).rows.map((r) => r.client_id as string);
    return cs.filter((_, i) => i % 3 !== 2);
  });
  const { ids } = await auto.commit(sys, { to: dates.addDays(today, -20), clientIds: toBill });
  await auto.commitRetainers(sys, ym(-1));
  // Issue all but two drafts; issue dates walk back so balances land in every ageing bucket.
  const offsets = [5, 12, 20, 40, 50, 70, 80, 100, 120, 150];
  // Numbers must follow date order within a series (D78): issue oldest first.
  const plan = ids.slice(0, Math.max(0, ids.length - 2)).map((id, i) => ({ id, issueDate: dates.addDays(today, -offsets[i % offsets.length]!) }))
    .sort((x, y) => (x.issueDate < y.issueDate ? -1 : x.issueDate > y.issueDate ? 1 : 0));
  for (const x of plan) await invoices.issue(sys, x.id, { issueDate: x.issueDate });
  const issued = plan.map((x) => x.id).reverse(); // newest first, as before
  const inv = async (id: string) => invoices.get(sys, id);
  if (issued.length >= 5) {
    const full = await inv(issued[3]!);
    await receipts.create(sys, { clientId: full.clientId as string, receivedOn: dates.addDays(today, -10), amountPaise: full.balancePaise, mode: 'bank', reference: 'NEFT DEMO001', allocations: [{ invoiceId: issued[3]!, amountPaise: full.balancePaise }] });
    const part = await inv(issued[4]!);
    const tds = Math.round(part.taxablePaise * 0.1);
    await receipts.create(sys, { clientId: part.clientId as string, receivedOn: dates.addDays(today, -8), amountPaise: Math.round(part.balancePaise / 2) - tds, tdsPaise: tds, tdsSection: '194J',
      mode: 'upi', reference: 'UPI DEMO002', allocations: [{ invoiceId: issued[4]!, amountPaise: Math.round(part.balancePaise / 2) - tds, tdsPaise: tds }] });
    const cn = await inv(issued[2]!);
    await invoices.note(sys, issued[2]!, { kind: 'credit_note', date: dates.addDays(today, -2), reason: 'Fee revised after discussion (demo)', lines: [{ description: 'Discount on GST compliance fees', taxablePaise: Math.min(50_000, Math.floor(cn.taxablePaise / 4)) }] });
    await receipts.create(sys, { clientId: (await inv(issued[0]!)).clientId as string, receivedOn: dates.addDays(today, -1), amountPaise: 500_000, mode: 'cheque', reference: 'CHQ 000123', allocations: [] });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  seedDemo(url).then((r) => {
    console.log(r.created ? `Demo firm created. Log in at firm "${DEMO.firm}" with any of:` : 'Demo firm already exists. Users:');
    for (const u of DEMO.users) console.log(`  ${u.role.padEnd(10)} ${u.email}  /  ${DEMO.password}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
