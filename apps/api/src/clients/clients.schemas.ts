import { ENTITY_TYPES, isValidGstin, isValidPan, isValidTan } from '@worko/domain';
import { z } from 'zod';

const phone = z.string().regex(/^\+?\d{10,15}$/, 'Invalid phone');
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();

export const registrationIn = z.object({
  kind: z.enum(['GSTIN', 'TAN', 'CIN', 'LLPIN', 'DIN', 'UDYAM', 'IEC', 'PF', 'ESI', 'PT', 'FSSAI', 'SHOPS', 'OTHER']),
  number: z.string().trim().toUpperCase().min(1).max(50), stateCode: opt(z.string().regex(/^\d{2}$/)), status: opt(z.string().max(50)),
  registeredOn: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), isPrimary: z.boolean().default(false),
}).superRefine((r, ctx) => {
  if (r.kind === 'GSTIN' && !isValidGstin(r.number)) ctx.addIssue({ code: 'custom', path: ['number'], message: 'Invalid GSTIN (checksum)' });
  if (r.kind === 'TAN' && !isValidTan(r.number)) ctx.addIssue({ code: 'custom', path: ['number'], message: 'Invalid TAN' });
});
export const contactIn = z.object({
  name: z.string().trim().min(1).max(200), role: opt(z.string().max(100)), email: opt(z.string().email().max(200)), phone: opt(phone),
  whatsapp: opt(phone), dob: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), anniversary: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), isPrimary: z.boolean().default(false),
});
const address = z.object({ kind: z.string().max(30).default('registered'), line1: z.string().max(200), line2: z.string().max(200).optional(), city: z.string().max(100), state: z.string().max(100), pin: z.string().regex(/^\d{6}$/) });
const bank = z.object({ bank: z.string().max(100), accountNo: z.string().regex(/^\d{6,20}$/), ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/), holder: z.string().max(200).optional() });

export const accessIn = z.object({
  branchId: opt(z.string().uuid()), partnerId: opt(z.string().uuid()), managerId: opt(z.string().uuid()), teamId: opt(z.string().uuid()),
  staffIds: z.array(z.string().uuid()).max(50).optional(), groupIds: z.array(z.string().uuid()).max(50).optional(),
  sensitive: z.boolean().optional(), allowedUserIds: z.array(z.string().uuid()).max(100).optional(),
});

export const clientBase = z.object({
  name: z.string().trim().min(1).max(300), tradeName: opt(z.string().trim().max(300)), fileNo: opt(z.string().trim().max(50)),
  entityType: z.enum(ENTITY_TYPES), pan: opt(z.string().trim().toUpperCase().refine(isValidPan, 'Invalid PAN')),
  tan: opt(z.string().trim().toUpperCase().refine(isValidTan, 'Invalid TAN')), cin: opt(z.string().max(30)), udyam: opt(z.string().max(30)), iec: opt(z.string().max(20)),
  dob: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), email: opt(z.string().trim().email().max(200)), phone: opt(phone),
  addresses: z.array(address).max(10).optional(), source: opt(z.string().max(100)), status: z.enum(['active', 'inactive', 'prospect']).optional(),
  tags: z.array(z.string().trim().max(50)).max(30).optional(), custom: z.record(z.unknown()).optional(), notes: opt(z.string().max(5000)),
  complianceProfile: z.record(z.unknown()).optional(),
  aadhaar: opt(z.string().regex(/^\d{4}\s?\d{4}\s?\d{4}$/, 'Aadhaar must be 12 digits')), bankAccounts: z.array(bank).max(10).optional(),
});
export const clientCreate = clientBase.extend({
  registrations: z.array(registrationIn).max(30).default([]), contacts: z.array(contactIn).max(50).default([]),
}).merge(accessIn);
export const clientPatch = clientBase.partial();
export type ClientCreate = z.infer<typeof clientCreate>;
export type ClientPatch = z.infer<typeof clientPatch>;
export type AccessIn = z.infer<typeof accessIn>;
