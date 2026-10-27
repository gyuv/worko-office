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
export async function seedDemo(url: string) {
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
      await seedPractice(tx, tenantId, branch, userIds);
    });
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
async function seedPractice(tx: Tx, tenantId: string, branch: string, users: Record<string, string>) {
  const r = rng(42);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const keys = new KeyService(new LocalKms());
  const storage = new LocalStorage();
  const team = uuidv7();
  await tx.query('INSERT INTO team (id, tenant_id, name, branch_id, lead_user_id) VALUES ($1,$2,$3,$4,$5)', [team, tenantId, 'GST team', branch, users.manager]);
  for (const u of [users.senior, users.article, users.manager]) await tx.query('INSERT INTO team_member (tenant_id, team_id, user_id) VALUES ($1,$2,$3)', [tenantId, team, u]);
  const groups = await Promise.all(['Kulkarni family', 'Sahyadri group of companies', 'Retail cluster – Pune'].map(async (name, i) => {
    const id = uuidv7();
    await tx.query('INSERT INTO client_group (id, tenant_id, name, kind) VALUES ($1,$2,$3,$4)', [id, tenantId, name, i === 0 ? 'family' : 'group']);
    return id;
  }));
  await tx.query(`INSERT INTO custom_field_def (id, tenant_id, entity, key, label, type, options) VALUES ($1,$2,'client','industry','Industry','select','["Manufacturing","Trading","Services","Professional"]')`, [uuidv7(), tenantId]);
  const today = new Date().toISOString().slice(0, 10);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  seedDemo(url).then((r) => {
    console.log(r.created ? `Demo firm created. Log in at firm "${DEMO.firm}" with any of:` : 'Demo firm already exists. Users:');
    for (const u of DEMO.users) console.log(`  ${u.role.padEnd(10)} ${u.email}  /  ${DEMO.password}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
