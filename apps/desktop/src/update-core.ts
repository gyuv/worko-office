// GENERATED copy of packages/domain/src/updates.ts (the desktop main process is CommonJS and ships no workspace
// packages). Edit the domain file, then: cp ../../packages/domain/src/updates.ts src/update-core.ts — a test checks they match.
/**
 * In-app updates from GitHub Releases (public repo, no token). Pure helpers shared by desktop, web and Android:
 * semver comparison and "which asset of which release should this device install".
 */
export const UPDATE_REPO = 'gyuv/worko-office';
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`;
/** Downloads are only ever accepted from this prefix (pinned, so a tampered release list cannot point elsewhere). */
export const DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPO}/releases/download/`;

export type UpdatePlatform = 'win' | 'mac-arm64' | 'mac-x64' | 'linux' | 'android';
export type GhAsset = { name: string; browser_download_url: string; size?: number; digest?: string | null };
export type GhRelease = { tag_name: string; name?: string | null; body?: string | null; html_url: string; draft?: boolean; prerelease?: boolean; published_at?: string | null; assets: GhAsset[] };
export type UpdateInfo = { version: string; url: string; fileName: string; size: number | null; sha256: string | null; notes: string; page: string };

type Ver = { core: [number, number, number]; pre: string[] };
export function parseVersion(v: string): Ver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: <0 if a<b, 0 if equal, >0 if a>b. Unparseable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const MATCH: Record<UpdatePlatform, (n: string) => boolean> = {
  win: (n) => /setup.*\.exe$/i.test(n),
  'mac-arm64': (n) => /arm64\.dmg$/i.test(n),
  'mac-x64': (n) => /\.dmg$/i.test(n) && !/arm64/i.test(n),
  linux: (n) => /\.appimage$/i.test(n),
  android: (n) => /\.apk$/i.test(n),
};

/** Newest non-draft release newer than `current` that carries an installer for `platform`, or null. */
export function pickUpdate(releases: GhRelease[], platform: UpdatePlatform, current: string): UpdateInfo | null {
  let best: UpdateInfo | null = null;
  for (const r of releases) {
    if (r.draft || !parseVersion(r.tag_name)) continue;
    const version = r.tag_name.replace(/^v/, '');
    if (compareVersions(version, current) <= 0 || (best && compareVersions(version, best.version) <= 0)) continue;
    const a = r.assets.find((x) => MATCH[platform](x.name) && x.browser_download_url.startsWith(DOWNLOAD_PREFIX));
    if (!a) continue;
    const sha = a.digest?.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : null;
    best = { version, url: a.browser_download_url, fileName: a.name.replace(/[^\w.-]/g, '_'), size: a.size ?? null, sha256: sha, notes: (r.body ?? '').slice(0, 2000), page: r.html_url };
  }
  return best;
}

/** Android versionCode from a semver (1.2.3 → 10203); monotonic for majors < 2100. */
export const androidVersionCode = (v: string) => { const p = parseVersion(v); return p ? p.core[0] * 10000 + p.core[1] * 100 + p.core[2] : 1; };
