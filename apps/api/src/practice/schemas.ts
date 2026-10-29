import { NOTICE_AUTHORITY_KEYS } from '@worko/domain';
import { z } from 'zod';
import { isoDate } from './common.js';

const uuid = z.string().uuid();
const txt = (n = 200) => z.string().trim().min(1).max(n);
const opt = (n = 200) => z.string().trim().max(n).nullable().optional();
export const paise = z.number().int().min(0).max(1e15);
export const yearRange = z.string().regex(/^\d{4}-\d{2}$/);
/** https only — hearing links open from devices and calendars. */
export const httpsUrl = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'https only');

export const noticeFields = {
  authority: z.enum(NOTICE_AUTHORITY_KEYS), level: z.string().regex(/^[a-z_]{2,40}$/).optional(), section: opt(40), referenceNo: opt(80), din: opt(80), title: txt(300),
  description: opt(5000), issueDate: isoDate.nullable().optional(), receivedOn: isoDate.optional(), responseDue: isoDate.nullable().optional(),
  assessmentYear: yearRange.nullable().optional(), financialYear: yearRange.nullable().optional(), period: opt(40), demandPaise: paise.optional(),
  assigneeId: uuid.nullable().optional(), reviewerId: uuid.nullable().optional(),
};
/** Fields an extraction may fill, validated exactly like a manual edit. */
export const extractableSchema = z.object({
  authority: noticeFields.authority, section: noticeFields.section, din: noticeFields.din, referenceNo: noticeFields.referenceNo, assessmentYear: noticeFields.assessmentYear,
  financialYear: noticeFields.financialYear, issueDate: noticeFields.issueDate, responseDue: noticeFields.responseDue, demandPaise: noticeFields.demandPaise,
}).partial().strict();
