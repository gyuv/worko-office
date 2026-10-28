import type { ResourceCtx } from './permissions.js';

export const ENTITY_TYPES = ['INDIVIDUAL', 'PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PRIVATE_COMPANY', 'PUBLIC_COMPANY', 'OPC', 'HUF', 'TRUST', 'AOP_BOI', 'SOCIETY', 'GOVERNMENT', 'OTHER'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * GST state/UT codes (first two digits of a GSTIN). VERIFY AGAINST OFFICIAL DOCS (CBIC/GSTN state code list);
 * 25 (Daman & Diu) was merged into 26 in 2020 but remains on older registrations.
 */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh (old)', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

/** PAN 4th character → holder type; a hint for the entity type (proprietors use the owner's individual PAN). */
export function entityHintFromPan(pan: string): EntityType | null {
  switch (pan.toUpperCase()[3]) {
    case 'P': return 'INDIVIDUAL';
    case 'C': return 'PRIVATE_COMPANY';
    case 'F': return 'PARTNERSHIP';
    case 'H': return 'HUF';
    case 'A': case 'B': return 'AOP_BOI';
    case 'T': return 'TRUST';
    case 'G': return 'GOVERNMENT';
    case 'L': case 'J': return 'OTHER';
    default: return null;
  }
}

/** The fields of a client row that decide who may see it. */
export type ClientVisibility = {
  branchId: string | null; partnerId: string | null; managerId: string | null; teamId: string | null;
  staffIds: string[]; groupIds: string[]; sensitive: boolean; allowedUserIds: string[];
};

/** Resource context for `can()` — the single definition of client visibility, mirrored in SQL by the API. */
export function clientCtx(c: ClientVisibility): ResourceCtx {
  return {
    branchId: c.branchId, teamId: c.teamId, clientGroupIds: c.groupIds,
    ownerUserIds: [c.partnerId, c.managerId, ...c.staffIds].filter((x): x is string => !!x),
    sensitive: c.sensitive, allowedUserIds: c.allowedUserIds,
  };
}
