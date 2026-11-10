// Release builds: stamp one version on every app from the tag (v1.2.3 → 1.2.3; anything else → 0.0.0-ci.<run>).
// Prints `WORKO_APP_VERSION=<v>` for $GITHUB_ENV and writes it into apps/desktop/package.json (app.getVersion()).
// The web build reads WORKO_APP_VERSION; the Android build reads it in app.config.js (version + versionCode).
import { readFileSync, writeFileSync } from 'node:fs';

const raw = (process.argv[2] || '').trim();
const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(raw);
const version = m ? m[1] : `0.0.0-ci.${process.env.GITHUB_RUN_NUMBER || '0'}`;
const file = new URL('../apps/desktop/package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(file, 'utf8'));
pkg.version = version;
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.error(`version: ${version}`);
console.log(`WORKO_APP_VERSION=${version}`);
