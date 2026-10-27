// Bundles the extension into dist/ and writes a manifest whose content-script matches come from PORTAL_HOSTS.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const common = { bundle: true, target: 'chrome114', platform: 'browser', legalComments: 'none', logLevel: 'warning' };

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({ ...common, entryPoints: [join(root, 'src/background.ts')], outfile: join(dist, 'background.js'), format: 'esm' });
await build({ ...common, entryPoints: [join(root, 'src/popup.ts')], outfile: join(dist, 'popup.js'), format: 'iife' });
await build({ ...common, entryPoints: [join(root, 'src/content.ts')], outfile: join(dist, 'content.js'), format: 'iife' });

for (const f of ['popup.html', 'popup.css']) await copyFile(join(root, 'public', f), join(dist, f));

// Evaluate the TS manifest template (bundled with its @worko/domain import) and write manifest.json.
const tpl = await build({ ...common, platform: 'node', entryPoints: [join(root, 'src/manifest.ts')], format: 'esm', write: false });
const mod = await import(`data:text/javascript;base64,${Buffer.from(tpl.outputFiles[0].text).toString('base64')}`);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(mod.buildManifest(pkg.version), null, 2)}\n`);
console.warn(`built ${dist}`);
