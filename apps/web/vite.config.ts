import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

/**
 * Release builds: the API may live on another origin (Vercel-hosted SPA, packaged desktop app). The CSP meta tag in
 * index.html only allows 'self', localhost and *.worko.in, so add the origin of VITE_API_URL / WORKO_API_BASE (and its
 * websocket twin) to connect-src at build time. Non-http(s) values are ignored.
 */
export function cspApiOrigins(...urls: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    try {
      const u = new URL(String(raw));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      out.add(u.origin); out.add(`${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`);
    } catch { /* unset or invalid */ }
  }
  return [...out];
}
const cspApiOrigin = (): Plugin => ({
  name: 'worko-csp-api-origin',
  transformIndexHtml: (html) => {
    const extra = cspApiOrigins(process.env.VITE_API_URL, process.env.WORKO_API_BASE);
    return extra.length ? html.replace("connect-src 'self'", `connect-src 'self' ${extra.join(' ')}`) : html;
  },
});

/** Identity of this build: the web app polls /version.json and offers a reload when a newer deploy is live. */
export const BUILD_ID = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || String(Date.now())).slice(0, 12);
export const APP_VERSION = process.env.WORKO_APP_VERSION || process.env.npm_package_version || '0.0.0';
const versionFile = (): Plugin => ({
  name: 'worko-version-json',
  apply: 'build',
  generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID, version: APP_VERSION }) }); },
});

export default defineConfig({
  plugins: [react(), cspApiOrigin(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __APP_VERSION__: JSON.stringify(APP_VERSION) },
  // Relative base so the same build loads from file:// inside Electron.
  base: './',
  server: { port: 5173, proxy: { '/v1': { target: 'http://localhost:3000', ws: true } } },
  // Node's Request needs absolute URLs (browsers resolve '/v1' against the page).
  test: { environment: 'jsdom', setupFiles: ['src/test-setup.ts'], css: false, env: { VITE_API_URL: 'http://localhost/v1' } },
});
