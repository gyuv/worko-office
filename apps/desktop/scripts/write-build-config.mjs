// Writes dist/build-config.json: the packaged default API base for this installer (release builds, D-release).
// WORKO_API_BASE comes from the build environment (CI input / repo variable); falls back to the local dev API.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const fallback = 'http://localhost:3000/v1';
const raw = (process.env.WORKO_API_BASE || '').trim();
let apiBase = fallback;
if (raw) {
  const u = new URL(raw); // throws on garbage → the build fails loudly instead of shipping a broken default
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) throw new Error(`WORKO_API_BASE must be https (got ${u.protocol})`);
  apiBase = raw.replace(/\/+$/, '');
}
mkdirSync(join(here, '..', 'dist'), { recursive: true });
writeFileSync(join(here, '..', 'dist', 'build-config.json'), JSON.stringify({ apiBase }, null, 2) + '\n');
console.log(`desktop build-config: apiBase=${apiBase}`);
