import { entityHintFromPan, GST_STATES, isValidGstin, panFromGstin, type EntityType } from '@worko/domain';

export type GstinDetails = {
  gstin: string; legalName: string; tradeName: string | null; status: 'Active' | 'Cancelled' | 'Suspended' | string;
  registrationDate: string | null; constitution: string | null; entityType: EntityType | null; stateCode: string; state: string;
  address: { line1: string; city: string; state: string; pin: string } | null; source: string;
};

/**
 * Taxpayer lookup by GSTIN through a licensed GSP/ASP or public-data provider. Never scrape the GST portal or
 * bypass its CAPTCHA. VERIFY AGAINST OFFICIAL DOCS of the chosen provider when wiring a real adapter.
 */
export interface GstinLookupProvider { lookup(gstin: string): Promise<GstinDetails | null> }
export const GSTIN_LOOKUP = 'GSTIN_LOOKUP';

/** Deterministic offline mock: derives what the GSTIN itself encodes; names are clearly synthetic. */
export class MockGstinLookup implements GstinLookupProvider {
  async lookup(gstin: string): Promise<GstinDetails | null> {
    const g = gstin.toUpperCase();
    if (!isValidGstin(g)) return null;
    const pan = panFromGstin(g); const code = g.slice(0, 2);
    const entityType = entityHintFromPan(pan);
    return {
      gstin: g, legalName: `Sample Taxpayer ${pan.slice(5, 9)}`, tradeName: null, status: 'Active', registrationDate: null,
      constitution: entityType, entityType, stateCode: code, state: GST_STATES[code] ?? 'Unknown', address: null, source: 'mock',
    };
  }
}
