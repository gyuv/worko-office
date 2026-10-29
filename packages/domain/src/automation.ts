import { z } from 'zod';
import { COMM_CHANNELS } from './comm.js';
import { TASK_PRIORITIES, TASK_STATUSES } from './tasks.js';

/**
 * M15 automation: a rule is trigger → conditions → actions, stored as validated JSON (this file), evaluated by a pure
 * evaluator. The API executes actions by calling the owning services, so every business rule, permission and audit applies.
 */

// ---------- Events ----------
/** Domain events written to the outbox in the same transaction as the source change (DB triggers, 0019). */
export const CHANGE_EVENTS = [
  'task.created', 'task.status_changed', 'invoice.issued', 'receipt.recorded', 'document.uploaded', 'notice.received',
  'lead.stage_changed', 'proposal.accepted', 'proposal.converted',
] as const;
/** Time-based events emitted by the daily scan (one per subject per IST day, dedupe-keyed). */
export const SCAN_EVENTS = ['task.overdue', 'compliance.due_soon', 'invoice.overdue', 'pbc.overdue', 'hearing.upcoming', 'dsc.expiring', 'licence.expiring'] as const;
export const AUTOMATION_EVENTS = [...CHANGE_EVENTS, ...SCAN_EVENTS, 'schedule'] as const;
export type AutomationEvent = (typeof AUTOMATION_EVENTS)[number];
export const isScanEvent = (e: string) => (SCAN_EVENTS as readonly string[]).includes(e);

/** How far ahead the scan looks (rules narrow it with `event.daysUntil`). */
export const SCAN_WINDOW_DAYS = 45;

/** Context sections each event provides (an action needing a section the event lacks is a validation error). */
export const EVENT_PROVIDES: Record<AutomationEvent, readonly Section[]> = {
  'task.created': ['client', 'task'], 'task.status_changed': ['client', 'task'], 'task.overdue': ['client', 'task'], 'compliance.due_soon': ['client', 'task'],
  'invoice.issued': ['client', 'invoice'], 'invoice.overdue': ['client', 'invoice'], 'receipt.recorded': ['client', 'receipt'],
  'document.uploaded': ['client', 'document'], 'pbc.overdue': ['client', 'pbc'], 'notice.received': ['client', 'notice', 'task'],
  'hearing.upcoming': ['client', 'hearing', 'notice', 'task'], 'dsc.expiring': ['client', 'dsc'], 'licence.expiring': ['client', 'licence'],
  'lead.stage_changed': ['lead'], 'proposal.accepted': ['proposal', 'lead'], 'proposal.converted': ['proposal', 'lead', 'client'], schedule: [],
};
export type Section = 'client' | 'task' | 'invoice' | 'receipt' | 'document' | 'pbc' | 'notice' | 'hearing' | 'dsc' | 'licence' | 'lead' | 'proposal';

// ---------- Typed context ----------
export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'string[]';
/** Every field a condition may read. Amounts are integer paise; dates are IST `YYYY-MM-DD`. */
export const CONTEXT_FIELDS: Record<string, FieldType> = {
  'event.type': 'string', 'event.daysUntil': 'number', 'event.daysOverdue': 'number', 'entity.type': 'string',
  'client.id': 'string', 'client.name': 'string', 'client.entityType': 'string', 'client.status': 'string', 'client.groupIds': 'string[]', 'client.tags': 'string[]',
  'client.branchId': 'string', 'client.portalEnabled': 'boolean',
  'task.status': 'string', 'task.fromStatus': 'string', 'task.priority': 'string', 'task.serviceKey': 'string', 'task.statutoryDue': 'date',
  'task.assigneeId': 'string', 'task.source': 'string', 'task.title': 'string',
  'invoice.status': 'string', 'invoice.totalPaise': 'number', 'invoice.balancePaise': 'number', 'invoice.dueDate': 'date',
  'receipt.amountPaise': 'number', 'document.source': 'string', 'document.category': 'string', 'document.name': 'string',
  'pbc.dueDate': 'date', 'notice.authority': 'string', 'notice.level': 'string', 'notice.demandPaise': 'number', 'notice.responseDue': 'date',
  'hearing.date': 'date', 'hearing.prepDone': 'boolean', 'dsc.validTo': 'date', 'dsc.holderKind': 'string', 'licence.licenceType': 'string', 'licence.validTo': 'date',
  'lead.stage': 'string', 'lead.fromStage': 'string', 'lead.source': 'string', 'lead.expectedValuePaise': 'number', 'proposal.status': 'string',
};
export type EventContext = Record<string, unknown> & { event: { type: string; daysUntil?: number | null; daysOverdue?: number | null }; entity: { type: string; id: string } };

export function getPath(ctx: unknown, path: string): unknown {
  let v: unknown = ctx;
  for (const k of path.split('.')) { if (v == null || typeof v !== 'object') return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
}

// ---------- Conditions ----------
export const CONDITION_OPS = ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'not_exists'] as const;
type Op = (typeof CONDITION_OPS)[number];
const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);
export type Leaf = { field: string; op: Op; value?: string | number | boolean | Array<string | number> };
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | Leaf;

const leafSchema = z.object({ field: z.string(), op: z.enum(CONDITION_OPS), value: z.union([scalar, z.array(z.union([z.string().max(200), z.number()])).max(100)]).optional() }).strict()
  .superRefine((c, ctx) => {
    const t = CONTEXT_FIELDS[c.field];
    if (!t) { ctx.addIssue({ code: 'custom', message: `Unknown field ${c.field}`, path: ['field'] }); return; }
    if (c.op === 'exists' || c.op === 'not_exists') return;
    if (c.value === undefined) { ctx.addIssue({ code: 'custom', message: 'Value required', path: ['value'] }); return; }
    const arr = Array.isArray(c.value);
    if ((c.op === 'in' || c.op === 'nin') !== arr) { ctx.addIssue({ code: 'custom', message: `${c.op} ${arr ? 'does not take' : 'needs'} a list`, path: ['value'] }); return; }
    const vals = arr ? (c.value as unknown[]) : [c.value];
    const want = t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string';
    if (vals.some((v) => typeof v !== want)) ctx.addIssue({ code: 'custom', message: `${c.field} compares with ${want}`, path: ['value'] });
    if (t === 'date' && vals.some((v) => !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))) ctx.addIssue({ code: 'custom', message: 'Dates are YYYY-MM-DD', path: ['value'] });
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && !['number', 'date'].includes(t)) ctx.addIssue({ code: 'custom', message: `${c.op} needs a number or date field`, path: ['op'] });
    if (c.op === 'contains' && t !== 'string[]' && t !== 'string') ctx.addIssue({ code: 'custom', message: 'contains needs a text or list field', path: ['op'] });
  });
export const conditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ all: z.array(conditionSchema).max(25) }).strict(),
  z.object({ any: z.array(conditionSchema).max(25) }).strict(),
  z.object({ not: conditionSchema }).strict(),
  leafSchema,
])) as z.ZodType<Condition>;

export type ConditionTrace = { field: string; op: Op; expected: unknown; actual: unknown; ok: boolean };

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}
function leafOk(c: Leaf, actual: unknown): boolean {
  const v = c.value;
  switch (c.op) {
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    case 'not_exists': return actual === undefined || actual === null || actual === '';
    case 'eq': return actual === v;
    case 'neq': return actual !== v;
    case 'in': return Array.isArray(v) && (v as unknown[]).includes(actual as never);
    case 'nin': return Array.isArray(v) && !(v as unknown[]).includes(actual as never);
    case 'contains': return Array.isArray(actual) ? actual.includes(v) : typeof actual === 'string' && typeof v === 'string' && actual.toLowerCase().includes(v.toLowerCase());
    default: {
      const d = cmp(actual, v);
      if (d === null) return false;
      return c.op === 'gt' ? d > 0 : c.op === 'gte' ? d >= 0 : c.op === 'lt' ? d < 0 : d <= 0;
    }
  }
}
/** Pure evaluator: missing fields never match comparisons (only `not_exists`). Empty `all` = true, empty `any` = false. */
export function evaluateCondition(c: Condition | undefined, ctx: unknown, trace: ConditionTrace[] = []): boolean {
  if (!c) return true;
  if ('all' in c) return c.all.every((x) => evaluateCondition(x, ctx, trace));
  if ('any' in c) return c.any.some((x) => evaluateCondition(x, ctx, trace));
  if ('not' in c) return !evaluateCondition(c.not, ctx, trace);
  const actual = getPath(ctx, c.field);
  const ok = leafOk(c, actual);
  trace.push({ field: c.field, op: c.op, expected: c.value, actual: actual ?? null, ok });
  return ok;
}

// ---------- Actions ----------
export const PERSON_REFS = ['owner', 'task_assignee', 'task_manager', 'client_partner', 'client_manager', 'hearing_owner', 'notice_assignee'] as const;
const personRef = z.union([z.enum(PERSON_REFS), z.object({ userId: z.string().uuid() }).strict()]);
export type PersonRef = z.infer<typeof personRef>;
const text = (max: number) => z.string().trim().min(1).max(max);
const when = z.enum(['always', 'first', 'repeat']).default('always');

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_task'), when, title: text(300), description: text(2000).optional(), assignee: personRef.default('owner'), dueInDays: z.number().int().min(0).max(365).optional(),
    priority: z.enum(TASK_PRIORITIES).default('normal'), checklist: z.array(text(200)).max(20).default([]) }).strict(),
  z.object({ type: z.literal('assign_task'), when, to: personRef }).strict(),
  z.object({ type: z.literal('add_checklist_item'), when, label: text(200), required: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('set_task_status'), when, status: z.enum(TASK_STATUSES), pendingIssue: text(500).optional() }).strict(),
  z.object({ type: z.literal('send_message'), when, channel: z.enum(COMM_CHANNELS), templateId: z.string().uuid().optional(), subject: text(200).optional(), body: text(4000).optional(),
    vars: z.record(z.string().max(40), z.string().max(500)).optional() }).strict(),
  z.object({ type: z.literal('create_pbc_request'), when, items: z.array(z.object({ title: text(300), dueInDays: z.number().int().min(0).max(365).optional() }).strict()).min(1).max(20) }).strict(),
  z.object({ type: z.literal('notify'), when, to: z.array(personRef).min(1).max(10), title: text(200), body: text(1000).optional(), priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal') }).strict(),
  z.object({ type: z.literal('add_timeline_note'), when, body: text(2000) }).strict(),
  z.object({ type: z.literal('create_invoice_draft'), when, description: text(300), ratePaise: z.number().int().min(0).max(1e12), sac: z.string().max(10).optional(), gstRate: z.number().min(0).max(28).optional(),
    linkTask: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('request_esign'), when, title: text(200) }).strict(),
  z.object({ type: z.literal('ai_draft_message'), when, channel: z.enum(COMM_CHANNELS), instruction: text(1000) }).strict(),
  z.object({ type: z.literal('ai_classify_upload'), when }).strict(),
]);
export type AutomationAction = z.infer<typeof actionSchema>;
export type ActionType = AutomationAction['type'];
export const ACTION_TYPES = actionSchema.options.map((o) => o.shape.type.value) as ActionType[];

/** Section of the context an action needs. */
export const ACTION_NEEDS: Partial<Record<ActionType, Section>> = {
  assign_task: 'task', add_checklist_item: 'task', set_task_status: 'task', send_message: 'client', create_pbc_request: 'pbc', add_timeline_note: 'client',
  create_invoice_draft: 'client', request_esign: 'document', ai_draft_message: 'client', ai_classify_upload: 'document',
};
/** Module × action the automation actor needs for each action (intersected with the owner's grants — D142). */
export const ACTION_PERMS: Record<ActionType, Array<[string, string]>> = {
  create_task: [['tasks', 'create'], ['tasks', 'assign'], ['tasks', 'edit']], assign_task: [['tasks', 'assign'], ['tasks', 'edit']], add_checklist_item: [['tasks', 'edit']], set_task_status: [['tasks', 'edit']],
  send_message: [['communication', 'create']], create_pbc_request: [['audit', 'edit']], notify: [], add_timeline_note: [['communication', 'create']],
  create_invoice_draft: [['billing', 'create']], request_esign: [['documents', 'edit']], ai_draft_message: [['ai', 'create'], ['communication', 'view']], ai_classify_upload: [['ai', 'create'], ['documents', 'view']],
};
/** Personal rules never contact clients, bill or sign (D142). */
export const PERSONAL_ACTIONS: readonly ActionType[] = ['create_task', 'assign_task', 'add_checklist_item', 'set_task_status', 'notify'];
/** Actions that can cost money (messages, AI tokens) — checked against the cost caps. */
export const COSTED_ACTIONS: readonly ActionType[] = ['send_message', 'ai_draft_message', 'ai_classify_upload'];

// ---------- Schedule (IST) ----------
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleSchema = z.object({ freq: z.enum(['daily', 'weekly', 'monthly']), at: hhmm.default('09:00'), weekday: z.number().int().min(0).max(6).optional(), monthDay: z.number().int().min(1).max(28).optional() }).strict()
  .refine((s) => s.freq !== 'weekly' || s.weekday !== undefined, { message: 'weekday required', path: ['weekday'] })
  .refine((s) => s.freq !== 'monthly' || s.monthDay !== undefined, { message: 'monthDay required', path: ['monthDay'] });
export type Schedule = z.infer<typeof scheduleSchema>;
const IST = 330 * 60_000;
/** First slot strictly after `after`, computed on the IST wall clock (no DST in India). */
export function nextRunAt(s: Schedule, after: Date): Date {
  const [h, m] = s.at.split(':').map(Number) as [number, number];
  const local = new Date(after.getTime() + IST);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  for (let i = 0; i < 400; i++) {
    const d = new Date(day.getTime() + i * 86_400_000);
    if (s.freq === 'weekly' && d.getUTCDay() !== s.weekday) continue;
    if (s.freq === 'monthly' && d.getUTCDate() !== s.monthDay) continue;
    const at = new Date(d.getTime() + (h * 60 + m) * 60_000 - IST);
    if (at > after) return at;
  }
  throw new Error('No schedule slot');
}

// ---------- Rule definition ----------
export const limitsSchema = z.object({
  maxActionsPerRun: z.number().int().min(1).max(50).default(10),
  maxActionsPerDay: z.number().int().min(1).max(5000).default(200),
  /** Messages + AI tokens attributed to this rule per IST month. */
  monthlyCostCapPaise: z.number().int().min(0).max(1e10).default(50_000),
  pauseAfterFailures: z.number().int().min(1).max(50).default(3),
}).strict();
export const ladderSchema = z.object({
  everyDays: z.number().int().min(1).max(60), maxSteps: z.number().int().min(1).max(20),
  stopOn: z.array(z.enum(CHANGE_EVENTS)).max(5).default([]), escalate: z.array(actionSchema).max(5).default([]),
}).strict();
export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: z.enum(AUTOMATION_EVENTS).refine((e) => e !== 'schedule', 'Use kind=schedule') }).strict(),
  z.object({ kind: z.literal('schedule'), schedule: scheduleSchema }).strict(),
]);
export const ruleDefinitionSchema = z.object({
  trigger: triggerSchema,
  conditions: conditionSchema.default({ all: [] }),
  actions: z.array(actionSchema).min(1).max(10),
  ladder: ladderSchema.optional(),
  limits: limitsSchema.default({}),
}).strict().superRefine((d, ctx) => {
  const ev: AutomationEvent = d.trigger.kind === 'event' ? d.trigger.event : 'schedule';
  const has = new Set(EVENT_PROVIDES[ev]);
  [...d.actions, ...(d.ladder?.escalate ?? [])].forEach((a, i) => {
    const need = ACTION_NEEDS[a.type];
    if (a.type === 'send_message' && !a.templateId && !a.body) ctx.addIssue({ code: 'custom', message: 'templateId or body required', path: ['actions', i, 'body'] });
    if (need && !has.has(need)) ctx.addIssue({ code: 'custom', message: `${a.type} needs a ${need} event`, path: ['actions', i] });
    if (a.type === 'notify' && a.to.some((p) => typeof p === 'string' && p !== 'owner' && !has.has(p.split('_')[0] as Section))) {
      ctx.addIssue({ code: 'custom', message: 'Recipient not available for this trigger', path: ['actions', i, 'to'] });
    }
  });
  if (d.ladder && !isScanEvent(ev)) ctx.addIssue({ code: 'custom', message: 'Ladders repeat on time-based triggers only', path: ['ladder'] });
});
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
export type RuleScope = 'firm' | 'personal';

/** Problems that make a definition unusable for a scope (zod handles the shape). */
export function scopeErrors(d: RuleDefinition, scope: RuleScope): string[] {
  if (scope === 'firm') return [];
  return [...d.actions, ...(d.ladder?.escalate ?? [])].filter((a) => !PERSONAL_ACTIONS.includes(a.type)).map((a) => `personal rules cannot ${a.type}`);
}

// ---------- Loop prevention ----------
export const MAX_CAUSATION_DEPTH = 3;
/** Carried by every event caused by automation: the rules that led to it (oldest first). */
export type Causation = { chain: string[]; depth: number; runId?: string | null };
export const ROOT_CAUSATION: Causation = { chain: [], depth: 0 };
export function causationVerdict(c: Causation | null | undefined, ruleId: string): 'ok' | 'self_trigger' | 'depth_limit' {
  const x = c ?? ROOT_CAUSATION;
  if (x.chain.includes(ruleId)) return 'self_trigger';
  if (x.depth >= MAX_CAUSATION_DEPTH) return 'depth_limit';
  return 'ok';
}
export const childCausation = (c: Causation | null | undefined, ruleId: string, runId: string): Causation =>
  ({ chain: [...(c ?? ROOT_CAUSATION).chain, ruleId], depth: (c ?? ROOT_CAUSATION).depth + 1, runId });

// ---------- Ladders (per rule × subject) ----------
export type SubjectState = { steps: number; lastStepDay: string | null; stoppedAt: string | null; escalated: boolean } | null;
export type LadderStep = 'first' | 'repeat' | 'escalate' | 'wait' | 'done';
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** What a time-based rule does for a subject today. Without a ladder a subject is handled once. */
export function ladderStep(state: SubjectState, ladder: RuleDefinition['ladder'], today: string): LadderStep {
  if (!state) return 'first';
  if (state.stoppedAt || !ladder) return 'done';
  if (state.lastStepDay && days(state.lastStepDay, today) < ladder.everyDays) return 'wait';
  if (state.steps < ladder.maxSteps) return 'repeat';
  if (ladder.escalate.length && !state.escalated) return 'escalate';
  return 'done';
}
/** Actions for a step (`when` filters first/repeat; escalation runs the ladder's escalate list). */
export function actionsForStep(d: RuleDefinition, step: LadderStep): AutomationAction[] {
  if (step === 'escalate') return d.ladder?.escalate ?? [];
  if (step !== 'first' && step !== 'repeat') return [];
  return d.actions.filter((a) => a.when === 'always' || a.when === step);
}

// ---------- Text rendering ----------
/** `{{client.name}}`-style placeholders from the context; unknown → ''. Output is plain text (comm escapes for HTML). */
export function renderAutomationText(tpl: string, ctx: unknown): string {
  return tpl.replace(/\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g, (_, p: string) => {
    const v = getPath(ctx, p);
    return v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  });
}

// ---------- Cost meter ----------
/** True when adding `estimatePaise` keeps month-to-date spend within the cap (cap 0 = no spend allowed). */
export const withinCap = (usedPaise: number, estimatePaise: number, capPaise: number | null | undefined) => capPaise == null || usedPaise + estimatePaise <= capPaise;

export const automationSettingsSchema = z.object({
  /** Firm kill switch: no rule runs while false. */
  enabled: z.boolean().default(true),
  maxActionsPerDay: z.number().int().min(1).max(100_000).default(2000),
  monthlyCostCapPaise: z.number().int().min(0).max(1e11).default(500_000),
  /** Recent events kept for dry-runs/history. */
  eventRetentionDays: z.number().int().min(7).max(365).default(90),
}).strict();
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;

// ---------- Prebuilt agents (templates as data → rules) ----------
export type AgentTemplate = {
  key: string; name: string; description: string; params: z.ZodTypeAny;
  build: (p: Record<string, unknown>) => RuleDefinition;
};
const GST_KEYS = ['GSTR1', 'GSTR3B'];
const p = <T extends z.ZodRawShape>(s: T) => z.object(s).strict();
const def = (d: unknown) => ruleDefinitionSchema.parse(d);
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    key: 'document_collection', name: 'Document Collection Agent',
    description: 'For subscribed services due soon: asks the client for documents (portal request + reminders on a ladder) until something is uploaded, then stops; escalates to the assignee.',
    params: p({ serviceKeys: z.array(z.string().max(40)).min(1).max(30).default(GST_KEYS), leadDays: z.number().int().min(1).max(SCAN_WINDOW_DAYS).default(10),
      channel: z.enum(COMM_CHANNELS).default('email'), templateId: z.string().uuid().optional(), everyDays: z.number().int().min(1).max(30).default(3), maxReminders: z.number().int().min(1).max(10).default(3) }),
    build: (x) => def({
      trigger: { kind: 'event', event: 'compliance.due_soon' },
      conditions: { all: [{ field: 'task.serviceKey', op: 'in', value: x.serviceKeys }, { field: 'event.daysUntil', op: 'lte', value: x.leadDays }, { field: 'event.daysUntil', op: 'gte', value: 0 },
        { field: 'task.status', op: 'in', value: ['open', 'pending_client'] }] },
      actions: [
        { type: 'set_task_status', when: 'first', status: 'pending_client', pendingIssue: 'Please upload the documents for {{task.title}} (due {{task.statutoryDue}}).' },
        x.templateId ? { type: 'send_message', channel: x.channel, templateId: x.templateId }
          : { type: 'send_message', channel: x.channel, subject: 'Documents needed: {{task.title}}', body: 'Dear {{client.name}},\n\nPlease share the documents for {{task.title}} (due {{task.statutoryDue}}) on the client portal or by reply.\n\nThank you.' },
      ],
      ladder: { everyDays: x.everyDays, maxSteps: x.maxReminders, stopOn: ['document.uploaded'],
        escalate: [{ type: 'notify', to: ['task_assignee', 'task_manager'], title: 'Documents still pending: {{task.title}}', body: '{{client.name}} has not sent documents after {{ladder.steps}} reminders.', priority: 'high' }] },
    }),
  },
  {
    key: 'overdue_nudger', name: 'Overdue Task Nudger', description: 'Nudges the assignee about overdue tasks every few days; escalates to the manager.',
    params: p({ everyDays: z.number().int().min(1).max(30).default(2), maxNudges: z.number().int().min(1).max(10).default(3) }),
    build: (x) => def({
      trigger: { kind: 'event', event: 'task.overdue' }, conditions: { all: [{ field: 'task.status', op: 'nin', value: ['done', 'cancelled'] }] },
      actions: [{ type: 'notify', to: ['task_assignee'], title: 'Overdue: {{task.title}}', body: '{{client.name}} — due {{task.statutoryDue}} ({{event.daysOverdue}} days overdue).', priority: 'high' }],
      ladder: { everyDays: x.everyDays, maxSteps: x.maxNudges, stopOn: [], escalate: [{ type: 'notify', to: ['task_manager'], title: 'Still overdue: {{task.title}}', priority: 'high' }] },
    }),
  },
  {
    key: 'invoice_followup', name: 'Invoice Follow-up',
    description: 'Tells the partner about overdue invoices and notes it on the timeline. Client reminders stay with the billing follow-up ladder (D145) — no double messages.',
    params: p({ afterDays: z.number().int().min(1).max(365).default(7) }),
    build: (x) => def({
      trigger: { kind: 'event', event: 'invoice.overdue' }, conditions: { all: [{ field: 'event.daysOverdue', op: 'gte', value: x.afterDays }] },
      actions: [{ type: 'notify', to: ['client_partner'], title: 'Invoice overdue: {{client.name}}', body: 'Balance ₹{{invoice.balanceRupees}} overdue {{event.daysOverdue}} days.' },
        { type: 'add_timeline_note', body: 'Invoice {{invoice.number}} is {{event.daysOverdue}} days overdue (automation).' }],
    }),
  },
  {
    key: 'renewal_reminder', name: 'DSC / licence renewal reminder', description: 'Reminds the client before a DSC or licence expires.',
    params: p({ kind: z.enum(['dsc', 'licence']).default('dsc'), withinDays: z.number().int().min(1).max(SCAN_WINDOW_DAYS).default(30), channel: z.enum(COMM_CHANNELS).default('email'), templateId: z.string().uuid().optional() }),
    build: (x) => def({
      trigger: { kind: 'event', event: x.kind === 'dsc' ? 'dsc.expiring' : 'licence.expiring' },
      conditions: { all: [{ field: 'event.daysUntil', op: 'lte', value: x.withinDays }, ...(x.kind === 'dsc' ? [{ field: 'dsc.holderKind', op: 'eq', value: 'client_contact' }] : [])] },
      actions: [x.templateId ? { type: 'send_message', channel: x.channel, templateId: x.templateId }
        : { type: 'send_message', channel: x.channel, subject: 'Renewal due', body: x.kind === 'dsc' ? 'Dear {{client.name}},\n\nThe digital signature certificate of {{dsc.holderName}} expires on {{dsc.validTo}}. Please let us know to renew it.' : 'Dear {{client.name}},\n\nYour {{licence.licenceType}} licence expires on {{licence.validTo}}. Please share the documents to renew it.' }],
    }),
  },
  {
    key: 'hearing_prep', name: 'Hearing prep reminder', description: 'Before a hearing: reminds the owner and adds a prep item to the notice task.',
    params: p({ prepDays: z.number().int().min(1).max(30).default(3) }),
    build: (x) => def({
      trigger: { kind: 'event', event: 'hearing.upcoming' }, conditions: { all: [{ field: 'event.daysUntil', op: 'lte', value: x.prepDays }, { field: 'hearing.prepDone', op: 'eq', value: false }] },
      actions: [{ type: 'notify', to: ['hearing_owner', 'notice_assignee'], title: 'Hearing on {{hearing.date}}: {{client.name}}', body: 'Prepare the submission, paper book and authorisation.', priority: 'high' },
        { type: 'add_checklist_item', label: 'Hearing prep for {{hearing.date}}: submission, paper book, authorisation', required: false }],
    }),
  },
  {
    key: 'client_onboarding', name: 'New client onboarding checklist', description: 'When a proposal is converted: an onboarding task with a checklist for the client manager.',
    params: p({ dueInDays: z.number().int().min(1).max(60).default(7) }),
    build: (x) => def({
      trigger: { kind: 'event', event: 'proposal.converted' },
      actions: [{ type: 'create_task', title: 'Onboarding: {{client.name}}', assignee: 'client_manager', dueInDays: x.dueInDays, priority: 'high',
        checklist: ['KYC documents (PAN, address proof)', 'Engagement letter signed', 'Portal invitation sent', 'Portal credentials saved in the vault', 'Services and billing rates set up'] },
      { type: 'notify', to: ['owner'], title: 'New client onboarding: {{client.name}}' }],
    }),
  },
  {
    key: 'portal_upload_triage', name: 'Portal upload triage', description: 'When a client uploads on the portal: tells the client team; optionally asks AI to suggest a category/FY (needs approval).',
    params: p({ classify: z.boolean().default(false) }),
    build: (x) => def({
      trigger: { kind: 'event', event: 'document.uploaded' }, conditions: { all: [{ field: 'document.source', op: 'eq', value: 'portal' }] },
      actions: [{ type: 'notify', to: ['client_manager', 'client_partner'], title: '{{client.name}} uploaded {{document.name}}', body: 'Review and file it.' },
        ...(x.classify ? [{ type: 'ai_classify_upload' }] : [])],
    }),
  },
];
export const agentTemplate = (key: string) => AGENT_TEMPLATES.find((t) => t.key === key);
