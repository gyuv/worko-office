import { fileURLToPath } from 'node:url';
import { PLATFORM_DEMO } from '../db/seed-platform.js';
import { DbService } from '../db/db.service.js';
import { PlatformAuditService } from './platform-audit.service.js';
import { createPlatformAdmin } from './platform-auth.service.js';

/**
 * Runs on every start (render.yaml). In production:
 *  - the demo super-admin from the seed (its password and TOTP secret are in the repository) is disabled and signed out;
 *  - if PLATFORM_ADMIN_EMAIL + PLATFORM_ADMIN_PASSWORD (≥ 12 chars) are set and that admin does not exist yet, it is created
 *    and its authenticator setup link is printed ONCE to the log. Later starts never print it again.
 */
export async function bootstrapPlatformAdmin(db: DbService, env = process.env, log: (s: string) => void = (s) => process.stdout.write(`${s}\n`)) {
  const paudit = new PlatformAuditService(db);
  if (env.NODE_ENV === 'production') {
    const off = await db.systemTx(async (tx) => {
      const r = await tx.query(`UPDATE platform_admin SET status = 'disabled' WHERE email = $1 AND status = 'active' RETURNING id`, [PLATFORM_DEMO.email]);
      if (r.rowCount) await tx.query('UPDATE platform_session SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [r.rows[0].id]);
      return r.rows[0]?.id as string | undefined;
    });
    if (off) {
      await paudit.record({ adminId: off, action: 'platform.admin_disabled', entity: 'platform_admin', entityId: off, diff: { reason: 'demo admin in production' } });
      log(`Disabled the demo platform admin ${PLATFORM_DEMO.email} (its credentials are public).`);
    }
  }
  const email = env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) return;
  if (password.length < 12) { log('PLATFORM_ADMIN_PASSWORD must be at least 12 characters; platform admin not created.'); return; }
  const exists = (await db.systemTx((tx) => tx.query('SELECT 1 FROM platform_admin WHERE email = $1', [email]))).rowCount;
  if (exists) return;
  const r = await db.systemTx((tx) => createPlatformAdmin(tx, { email, name: env.PLATFORM_ADMIN_NAME?.trim() || 'Platform admin', password }));
  await paudit.record({ adminId: r.id, action: 'platform.admin_created', entity: 'platform_admin', entityId: r.id, diff: { via: 'bootstrap' } });
  log(`Platform admin ${email} created. Add it to an authenticator app now (shown only this once):`);
  log(`  setup key: ${r.totpSecret}`);
  log(`  link: ${r.otpauthUrl}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = new DbService();
  bootstrapPlatformAdmin(db).catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.pool.end());
}
