import { PORTAL_HOSTS, PORTALS } from '@worko/domain';
import { describe, expect, it } from 'vitest';
import { buildManifest, portalMatches } from './manifest.js';

describe('manifest', () => {
  const m = buildManifest('1.2.3');
  const cs = m.content_scripts![0]!;

  it('content-script matches are exactly https://<host>/* for every allow-listed host', () => {
    const expected = new Set<string>();
    for (const p of PORTALS) if (!['BANK', 'PT', 'OTHER'].includes(p)) for (const h of PORTAL_HOSTS[p]) expected.add(`https://${h}/*`);
    expect(new Set(cs.matches)).toEqual(expected);
    expect(cs.matches).toEqual(portalMatches());
    for (const pat of cs.matches!) expect(pat).toMatch(/^https:\/\/[a-z0-9.-]+\/\*$/);
    expect(cs.all_frames).toBe(false);
  });

  it('never matches BANK/PT/OTHER and has no wildcards or <all_urls>', () => {
    for (const p of ['BANK', 'PT', 'OTHER'] as const) for (const h of PORTAL_HOSTS[p]) expect(cs.matches).not.toContain(`https://${h}/*`);
    const json = JSON.stringify(m);
    expect(json).not.toContain('<all_urls>');
    for (const pat of cs.matches!) expect(pat).not.toContain('*.');
    expect(m.host_permissions!.filter((h) => h.includes('*.'))).toEqual(['https://*.worko.in/*']);
  });

  it('permissions are minimal', () => {
    expect(m.permissions).toEqual(['storage']);
    expect(m.host_permissions).toEqual(expect.arrayContaining(['http://localhost:3000/*', 'https://*.worko.in/*']));
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe('1.2.3');
    expect(m.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });
});
