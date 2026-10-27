import { PORTAL_HOSTS, PORTALS, type Portal } from '@worko/domain';

/** Portals the extension may autofill. BANK/PT/OTHER are never autofilled, even if hosts are ever added. */
export const NEVER_AUTOFILL: readonly Portal[] = ['BANK', 'PT', 'OTHER'];

export const DEFAULT_API_ORIGINS = ['http://localhost:3000/*', 'https://*.worko.in/*'] as const;

/** Exact `https://<host>/*` patterns for every allow-listed portal host. */
export function portalMatches(): string[] {
  const out = new Set<string>();
  for (const p of PORTALS) {
    if (NEVER_AUTOFILL.includes(p)) continue;
    for (const h of PORTAL_HOSTS[p]) out.add(`https://${h}/*`);
  }
  return [...out].sort();
}

export function buildManifest(version: string): chrome.runtime.ManifestV3 {
  const matches = portalMatches();
  return {
    manifest_version: 3,
    name: 'Worko Autofill',
    version,
    description: 'Fills government portal logins from your firm’s Worko vault. Never submits forms or touches CAPTCHAs.',
    // storage: session tokens (chrome.storage.session) + non-secret settings (chrome.storage.local). Nothing else:
    // tab URLs are readable for portal tabs via the host permissions below, so `tabs`/`activeTab` are not needed.
    permissions: ['storage'],
    // Portal hosts (to read the active tab's URL on portals only) + the default API origins.
    host_permissions: [...matches, ...DEFAULT_API_ORIGINS],
    // A self-hosted API origin is requested at runtime from the popup (user gesture) via chrome.permissions.request.
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: 'Worko Autofill' },
    content_scripts: [{ matches, js: ['content.js'], run_at: 'document_idle', all_frames: false }],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  };
}
