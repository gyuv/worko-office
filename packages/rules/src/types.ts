import { z } from 'zod';

/** Due date is computed relative to the period: anchor + addMonths, then a day-of-month. */
export const dueExprSchema = z.object({
  anchor: z.enum(['period_start', 'period_end', 'fy_start', 'fy_end']),
  addMonths: z.number().int().min(-24).max(60).default(0),
  day: z.union([z.number().int().min(1).max(31), z.literal('last')]),
});
export type DueExpr = z.infer<typeof dueExprSchema>;

const condSchema = z.object({
  field: z.string(),
  op: z.enum(['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'truthy']),
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof condSchema>;
export const predicateSchema = z.object({ all: z.array(condSchema).optional(), any: z.array(condSchema).optional() });
export type Predicate = z.infer<typeof predicateSchema>;

export const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_.-]+$/),
  regime: z.enum(['GST', 'INCOME_TAX', 'TDS', 'ROC', 'LLP', 'PF', 'ESI', 'PT', 'FEMA', 'SEBI', 'OTHER']),
  form: z.string(),
  title: z.string(),
  frequency: z.enum(['monthly', 'quarterly', 'annual', 'event']),
  applicability: predicateSchema.default({}),
  due: dueExprSchema,
  /** Per-period exceptions, keyed by period-end month (1-12), e.g. TDS for March. */
  periodOverrides: z.array(z.object({ periodEndMonth: z.number().int().min(1).max(12), due: dueExprSchema })).default([]),
  holidayShift: z.enum(['none', 'next_working_day', 'previous_working_day']).default('none'),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  penaltyHint: z.string().optional(),
  serviceTypeKey: z.string().optional(),
  verified: z.boolean().default(false),
  source: z.string().optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const rulePackSchema = z.object({
  id: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  publishedAt: z.string(),
  notes: z.string().optional(),
  rules: z.array(ruleSchema),
});
export type RulePack = z.infer<typeof rulePackSchema>;

export const extensionSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  periodKey: z.string(),
  newDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scope: predicateSchema.default({}),
  notification: z.string().optional(),
});
export type Extension = z.infer<typeof extensionSchema>;

/** Facts about a client the predicates evaluate against. */
export type ClientFacts = Record<string, unknown> & { id: string };

export type Period = { key: string; start: string; end: string; label: string };
export type DueItem = {
  clientId: string; ruleId: string; form: string; period: Period;
  statutoryDue: string; actBy: string; extensionId?: string;
};
