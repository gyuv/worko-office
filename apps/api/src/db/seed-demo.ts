import { fileURLToPath } from 'node:url';
import { AuditService } from '../audit/audit.service.js';
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
      for (const u of rest) {
        const id = uuidv7();
        await tx.query('INSERT INTO app_user (id, tenant_id, email, phone, name, password_hash, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, tenantId, u.email, u.phone, u.name, hash, branch]);
        await tx.query('INSERT INTO user_role (tenant_id, user_id, role_id) SELECT $1, $2, id FROM role WHERE key = $3', [tenantId, id, u.role]);
      }
    });
    return { created: true, tenantId };
  } finally {
    await db.pool.end();
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
