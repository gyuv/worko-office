/**
 * Official government portal hosts the browser extension may autofill on, per credential type.
 * VERIFY AGAINST OFFICIAL DOCS — hosts change; keep this list tight (no wildcards, https only).
 */
export const PORTALS = ['GST', 'INCOME_TAX', 'TRACES', 'MCA', 'EPFO', 'ESIC', 'BANK', 'PT', 'DGFT', 'OTHER'] as const;
export type Portal = (typeof PORTALS)[number];

export const PORTAL_HOSTS: Record<Portal, readonly string[]> = {
  GST: ['services.gst.gov.in', 'www.gst.gov.in', 'gst.gov.in'],
  INCOME_TAX: ['eportal.incometax.gov.in', 'www.incometax.gov.in'],
  TRACES: ['www.tdscpc.gov.in'],
  MCA: ['www.mca.gov.in'],
  EPFO: ['unifiedportal-emp.epfindia.gov.in'],
  ESIC: ['portal.esic.gov.in', 'www.esic.gov.in'],
  DGFT: ['www.dgft.gov.in'],
  // Never autofilled: bank and state PT sites vary too much to allow-list safely.
  BANK: [], PT: [], OTHER: [],
};

/** True only for an https URL whose exact host is allow-listed for this portal. */
export function isPortalUrl(portal: Portal, url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && PORTAL_HOSTS[portal].includes(u.hostname.toLowerCase()) && !u.port;
  } catch { return false; }
}

export function portalForUrl(url: string): Portal | null {
  for (const p of PORTALS) if (isPortalUrl(p, url)) return p;
  return null;
}
