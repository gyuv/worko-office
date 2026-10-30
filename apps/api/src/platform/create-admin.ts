import { fileURLToPath } from 'node:url';
import { DbService } from '../db/db.service.js';
import { PlatformAuditService } from './platform-audit.service.js';
import { createPlatformAdmin } from './platform-auth.service.js';

/**
 * CLI: `DATABASE_URL=… pnpm --filter @worko/api platform:admin <email> "<name>"` with the password in PLATFORM_ADMIN_PASSWORD.
 * Prints the TOTP secret once (add it to an authenticator app). There is deliberately no HTTP route for this (D178).
 */
async function main() {
  const [email, name] = process.argv.slice(2);
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !name || !password || password.length < 12) throw new Error('Usage: PLATFORM_ADMIN_PASSWORD=<≥12 chars> platform:admin <email> "<name>"');
  const db = new DbService();
  try {
    const r = await db.systemTx((tx) => createPlatformAdmin(tx, { email, name, password }));
    await new PlatformAuditService(db).record({ adminId: r.id, action: 'platform.admin_created', entity: 'platform_admin', entityId: r.id, diff: { via: 'cli' } });
    process.stdout.write(`Platform admin ${email} created. Add this to an authenticator app now (shown once):\n  ${r.otpauthUrl}\n`);
  } finally { await db.pool.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
