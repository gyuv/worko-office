import { z } from 'zod';
import { AGEING_BUCKETS, RECEIPT_MODES } from './billing.js';
import { LEAD_SOURCES, LEAD_STAGES, PROPOSAL_STATUSES } from './crm.js';
import { addDaysIso, istDate, mondayOf } from './hr.js';
import type { Module } from './permissions.js';
import { AGE_BUCKETS, NOTICE_STATUSES } from './practice.js';
import { TASK_OUTCOMES, TASK_PRIORITIES, TASK_STATUSES } from './tasks.js';

/**
 * M17 report definition language (Phase 11). A definition names a dataset from a FIXED catalogue, picks typed columns,
 * filters, ≤2 group-by levels, aggregates, sort, limit and a chart hint. It is pure data: the server compiles it to
 * parameterised SQL over a whitelist (no SQL from clients, ever) and always ANDs the requesting actor's row scope.
 * Money stays integer paise; formatting is client-side.
 */

// ---------- Columns & datasets ----------
export const COLUMN_TYPES = ['text', 'id', 'enum', 'date', 'datetime', 'int', 'paise', 'minutes', 'number', 'bool'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export const NUMERIC_TYPES: readonly ColumnType[] = ['int', 'paise', 'minutes', 'number'];
/** cost = cost rates/margins (canSeeCost); pii = identifiers/contact details; fees = rate-table fees; invoice = invoice amounts. */
export type Sensitivity = 'cost' | 'pii' | 'fees' | 'invoice';
export const REF_TYPES = ['client', 'task', 'invoice', 'receipt', 'notice', 'lead', 'proposal', 'user', 'time_entry', 'leave_request', 'expense_claim', 'dsc', 'licence', 'automation_rule', 'automation_run'] as const;
export type RefType = (typeof REF_TYPES)[number];

export type ColumnMeta = {
  key: string; label: string; type: ColumnType; description?: string; values?: readonly string[];
  sensitivity?: Sensitivity;
  /** Role field-hiding key (`hiddenFields`), e.g. 'client.pan'; a `prefix.*` entry hides it too. */
  hiddenKey?: string;
  /** Id columns that point at an entity the UI can open (drill-through). */
  ref?: RefType;
};
export type ParamSpec = { key: string; type: 'date' | 'month' | 'int' | 'enum'; default: string | number; values?: readonly string[]; min?: number; max?: number; description: string };
export type DatasetMeta = {
  key: string; label: string; description: string;
  /** Source module whose `view` the dataset needs (besides reports:view); its row scope applies. */
  module: Module;
  /** The row's own entity (id column `id`), for navigation. */
  entity?: RefType;
  columns: ColumnMeta[];
  params?: ParamSpec[];
};

const c = (key: string, label: string, type: ColumnType, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({ key, label, type, ...extra });
const clientCols = [c('clientId', 'Client id', 'id', { ref: 'client' }), c('clientName', 'Client', 'text')];
const INVOICE_KINDS = ['invoice', 'credit_note', 'debit_note'] as const;
const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'cancelled'] as const;
const COMPLIANCE_STATES = ['done', 'overdue', 'open', 'not_created'] as const;
const TIME_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;
const LEAVE_STATUSES = ['pending', 'approved', 'partially_approved', 'rejected', 'cancelled'] as const;
const EXPENSE_STATUSES = ['draft', 'submitted', 'approved', 'partially_approved', 'rejected', 'paid'] as const;
const RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed', 'skipped', 'no_match'] as const;
const DSC_CUSTODY = ['in_office', 'with_client', 'with_staff'] as const;

export const DATASETS: readonly DatasetMeta[] = [
  { key: 'tasks', label: 'Tasks', description: 'Work items (compliance and other services) with assignee, due dates and status.', module: 'tasks', entity: 'task', columns: [
    c('id', 'Task id', 'id', { ref: 'task' }), c('title', 'Task', 'text'), ...clientCols, c('serviceName', 'Service', 'text'), c('serviceCategory', 'Service category', 'text', { description: 'e.g. GST, Income tax, TDS, ROC' }),
    c('status', 'Status', 'enum', { values: TASK_STATUSES }), c('priority', 'Priority', 'enum', { values: TASK_PRIORITIES }), c('outcome', 'Outcome', 'enum', { values: TASK_OUTCOMES }),
    c('periodKey', 'Period', 'text'), c('statutoryDue', 'Statutory due', 'date'), c('actBy', 'Act by', 'date'), c('completedAt', 'Completed at', 'datetime'),
    c('assigneeId', 'Assignee id', 'id', { ref: 'user' }), c('assigneeName', 'Assignee', 'text'), c('managerName', 'Manager', 'text'), c('reviewerName', 'Reviewer', 'text'),
    c('overdue', 'Overdue', 'bool', { description: 'Open and past act-by (else statutory) date' }), c('daysOverdue', 'Days overdue', 'int'), c('estimateMinutes', 'Estimate', 'minutes')] },
  { key: 'time_entries', label: 'Time entries', description: 'Logged time per person, client and task; cost is the person\'s cost rate × minutes.', module: 'time', entity: 'time_entry', columns: [
    c('id', 'Entry id', 'id', { ref: 'time_entry' }), c('workDate', 'Date', 'date'), c('week', 'Week (Mon)', 'date'), c('month', 'Month', 'text'), c('userId', 'User id', 'id', { ref: 'user' }), c('userName', 'User', 'text'),
    ...clientCols, c('taskId', 'Task id', 'id', { ref: 'task' }), c('taskTitle', 'Task', 'text'), c('minutes', 'Minutes', 'minutes'), c('billable', 'Billable', 'bool'),
    c('status', 'Status', 'enum', { values: TIME_STATUSES }), c('costPaise', 'Cost', 'paise', { sensitivity: 'cost', hiddenKey: 'cost.*' })] },
  { key: 'invoices', label: 'Invoices', description: 'Invoices, credit and debit notes with GST split and balance.', module: 'billing', entity: 'invoice', columns: [
    c('id', 'Invoice id', 'id', { ref: 'invoice' }), c('number', 'Number', 'text'), c('kind', 'Type', 'enum', { values: INVOICE_KINDS }), c('status', 'Status', 'enum', { values: INVOICE_STATUSES }),
    c('issueDate', 'Issue date', 'date'), c('issueMonth', 'Issue month', 'text'), c('dueDate', 'Due date', 'date'), ...clientCols, c('entityName', 'Billing entity', 'text'),
    c('partnerName', 'Partner', 'text'), c('branchName', 'Branch', 'text'),
    ...(['taxablePaise:Taxable', 'cgstPaise:CGST', 'sgstPaise:SGST', 'igstPaise:IGST', 'totalPaise:Total', 'balancePaise:Balance'].map((s) => { const [k, l] = s.split(':') as [string, string]; return c(k, l, 'paise', { sensitivity: 'invoice', hiddenKey: 'invoice.amounts' }); })),
    c('daysPastDue', 'Days past due', 'int')] },
  { key: 'invoice_lines', label: 'Invoice lines', description: 'Invoice lines by service (revenue = taxable value of issued invoices).', module: 'billing', entity: 'invoice', columns: [
    c('id', 'Invoice id', 'id', { ref: 'invoice' }), c('number', 'Invoice number', 'text'), c('kind', 'Type', 'enum', { values: INVOICE_KINDS }), c('status', 'Status', 'enum', { values: INVOICE_STATUSES }),
    c('issueDate', 'Issue date', 'date'), c('issueMonth', 'Issue month', 'text'), ...clientCols, c('serviceName', 'Service', 'text'), c('serviceCategory', 'Service category', 'text'),
    c('description', 'Description', 'text'), c('reimbursement', 'Reimbursement', 'bool'), c('partnerName', 'Partner', 'text'), c('branchName', 'Branch', 'text'),
    c('taxablePaise', 'Taxable', 'paise', { sensitivity: 'invoice', hiddenKey: 'invoice.amounts' }), c('totalPaise', 'Total', 'paise', { sensitivity: 'invoice', hiddenKey: 'invoice.amounts' })] },
  { key: 'receipts', label: 'Receipts', description: 'Payments received (collections), TDS and allocation.', module: 'receipts', entity: 'receipt', columns: [
    c('id', 'Receipt id', 'id', { ref: 'receipt' }), c('number', 'Number', 'text'), c('receivedOn', 'Received on', 'date'), c('receivedMonth', 'Month', 'text'), ...clientCols,
    c('mode', 'Mode', 'enum', { values: RECEIPT_MODES }), c('amountPaise', 'Amount', 'paise', { sensitivity: 'invoice', hiddenKey: 'invoice.amounts' }), c('tdsPaise', 'TDS', 'paise', { sensitivity: 'invoice', hiddenKey: 'invoice.amounts' }),
    c('allocatedPaise', 'Allocated', 'paise', { sensitivity: 'invoice', hiddenKey: 'invoice.amounts' }), c('unallocatedPaise', 'Advance', 'paise', { sensitivity: 'invoice', hiddenKey: 'invoice.amounts' })] },
  { key: 'ageing', label: 'Receivables ageing', description: 'Open receivables per client and days-past-due bucket (same figures as Billing → Ageing).', module: 'billing', columns: [
    ...clientCols, c('bucket', 'Bucket', 'enum', { values: AGEING_BUCKETS }), c('balancePaise', 'Outstanding', 'paise', { sensitivity: 'invoice', hiddenKey: 'invoice.amounts' })],
  params: [{ key: 'asOf', type: 'date', default: 'today', description: 'Ageing as of (IST)' }] },
  { key: 'unbilled', label: 'Unbilled work', description: 'Completed tasks not yet invoiced, with the suggested fee from the rate tables (same as Billing → Unbilled).', module: 'billing', entity: 'task', columns: [
    c('id', 'Task id', 'id', { ref: 'task' }), c('title', 'Task', 'text'), ...clientCols, c('periodKey', 'Period', 'text'), c('serviceKey', 'Service key', 'text'), c('serviceName', 'Service', 'text'),
    c('serviceCategory', 'Service category', 'text', { description: 'e.g. GST, Income tax, TDS, ROC' }), c('completedOn', 'Completed on', 'date'), c('assigneeId', 'Assignee id', 'id', { ref: 'user' }),
    c('assigneeName', 'Assignee (user)', 'text'), c('retainer', 'Retainer', 'bool'), c('suggestedPaise', 'Suggested fee', 'paise', { sensitivity: 'fees', hiddenKey: 'client.fees' })] },
  { key: 'job_pnl', label: 'Job P&L', description: 'Revenue, cost, WIP and margin per task/client/service (same as Time → Job P&L). Cost and margin need cost visibility.', module: 'reports', columns: [
    c('key', 'Key', 'text'), c('label', 'Job', 'text'), ...clientCols, c('taskId', 'Task id', 'id', { ref: 'task' }), c('revenuePaise', 'Revenue', 'paise'),
    c('costPaise', 'Cost', 'paise', { sensitivity: 'cost', hiddenKey: 'cost.*' }), c('marginPaise', 'Margin', 'paise', { sensitivity: 'cost', hiddenKey: 'cost.*' }), c('marginPct', 'Margin %', 'number', { sensitivity: 'cost', hiddenKey: 'cost.*' }),
    c('wipPaise', 'WIP', 'paise'), c('minutes', 'Minutes', 'minutes'), c('billableMinutes', 'Billable minutes', 'minutes'), c('loss', 'Loss-making', 'bool', { sensitivity: 'cost', hiddenKey: 'cost.*' })],
  params: [{ key: 'from', type: 'date', default: 'fy_start', description: 'From (IST)' }, { key: 'to', type: 'date', default: 'today', description: 'To (IST)' },
    { key: 'groupBy', type: 'enum', default: 'client', values: ['task', 'client', 'service'], description: 'Job level' }] },
  { key: 'capacity', label: 'Capacity & utilisation', description: 'Per person × week: capacity (after holidays/leave), planned (open task estimates) and actual (approved time) — same as Time → Capacity.', module: 'time', columns: [
    c('userId', 'User id', 'id', { ref: 'user' }), c('userName', 'User', 'text'), c('weekStart', 'Week (Mon)', 'date'), c('capacityMinutes', 'Capacity', 'minutes'), c('plannedMinutes', 'Planned', 'minutes'),
    c('actualMinutes', 'Actual', 'minutes'), c('plannedPct', 'Planned %', 'number'), c('actualPct', 'Utilisation %', 'number')],
  params: [{ key: 'from', type: 'date', default: 'weeks_back_3', description: 'First week (any day in it); default: 3 weeks before this one' }, { key: 'weeks', type: 'int', default: 4, min: 1, max: 26, description: 'Weeks' }] },
  { key: 'clients', label: 'Clients', description: 'Client master. PAN, e-mail and phone follow field hiding.', module: 'clients', entity: 'client', columns: [
    c('id', 'Client id', 'id', { ref: 'client' }), c('fileNo', 'File no.', 'text'), c('name', 'Client', 'text'), c('entityType', 'Entity type', 'text'), c('status', 'Status', 'text'),
    c('pan', 'PAN', 'text', { sensitivity: 'pii', hiddenKey: 'client.pan' }), c('email', 'E-mail', 'text', { sensitivity: 'pii', hiddenKey: 'client.email' }), c('phone', 'Phone', 'text', { sensitivity: 'pii', hiddenKey: 'client.phone' }),
    c('branchName', 'Branch', 'text'), c('partnerName', 'Partner', 'text'), c('managerName', 'Manager', 'text'), c('createdAt', 'Created at', 'datetime')] },
  { key: 'compliance', label: 'Compliance status', description: 'Statutory items per client × rule × period with state (same as Compliance → Matrix).', module: 'compliance', columns: [
    ...clientCols, c('ruleId', 'Rule', 'text'), c('form', 'Form', 'text'), c('periodKey', 'Period', 'text'), c('periodLabel', 'Period label', 'text'), c('statutoryDue', 'Statutory due', 'date'),
    c('actBy', 'Act by', 'date'), c('state', 'State', 'enum', { values: COMPLIANCE_STATES }), c('taskId', 'Task id', 'id', { ref: 'task' })],
  params: [{ key: 'from', type: 'date', default: 'month_start', description: 'Due from' }, { key: 'to', type: 'date', default: 'month_end', description: 'Due to' }, { key: 'asOf', type: 'date', default: 'today', description: 'State as of' }] },
  { key: 'notices', label: 'Notices', description: 'Department notices with authority, level, age and demand.', module: 'notices', entity: 'notice', columns: [
    c('id', 'Notice id', 'id', { ref: 'notice' }), c('title', 'Notice', 'text'), ...clientCols, c('authority', 'Authority', 'text'), c('level', 'Level', 'text'), c('section', 'Section', 'text'),
    c('status', 'Status', 'enum', { values: NOTICE_STATUSES }), c('receivedOn', 'Received on', 'date'), c('responseDue', 'Response due', 'date'), c('ageDays', 'Age (days)', 'int'),
    c('ageBucket', 'Age bucket', 'enum', { values: AGE_BUCKETS }), c('demandPaise', 'Demand', 'paise'), c('assigneeName', 'Assignee', 'text'), c('overdue', 'Reply overdue', 'bool')] },
  { key: 'leads', label: 'Leads', description: 'Sales pipeline. E-mail, phone and PAN follow field hiding.', module: 'leads', entity: 'lead', columns: [
    c('id', 'Lead id', 'id', { ref: 'lead' }), c('name', 'Lead', 'text'), c('company', 'Company', 'text'), c('stage', 'Stage', 'enum', { values: LEAD_STAGES }), c('source', 'Source', 'enum', { values: LEAD_SOURCES }),
    c('ownerName', 'Owner', 'text'), c('expectedValuePaise', 'Expected value', 'paise'), c('converted', 'Converted', 'bool'), c('createdAt', 'Created at', 'datetime'), c('createdMonth', 'Created month', 'text'),
    c('email', 'E-mail', 'text', { sensitivity: 'pii', hiddenKey: 'lead.email' }), c('phone', 'Phone', 'text', { sensitivity: 'pii', hiddenKey: 'lead.phone' }), c('pan', 'PAN', 'text', { sensitivity: 'pii', hiddenKey: 'lead.pan' })] },
  { key: 'proposals', label: 'Proposals', description: 'Proposals to leads and their outcome.', module: 'leads', entity: 'proposal', columns: [
    c('id', 'Proposal id', 'id', { ref: 'proposal' }), c('number', 'Number', 'text'), c('title', 'Title', 'text'), c('leadId', 'Lead id', 'id', { ref: 'lead' }), c('leadName', 'Lead', 'text'),
    c('status', 'Status', 'enum', { values: PROPOSAL_STATUSES }), c('currentVersion', 'Version', 'int'), c('sentAt', 'Sent at', 'datetime'), c('decidedAt', 'Decided at', 'datetime'), c('converted', 'Converted', 'bool')] },
  { key: 'attendance', label: 'Attendance summary', description: 'Per person for a month: working, present, leave and absent days (same as HR → Attendance report).', module: 'hr', columns: [
    c('userId', 'User id', 'id', { ref: 'user' }), c('userName', 'User', 'text'), c('workingDays', 'Working days', 'int'), c('presentDays', 'Present', 'int'), c('leaveDays', 'Leave', 'number'),
    c('absentDays', 'Absent', 'number'), c('flaggedDays', 'Flagged', 'int'), c('minutes', 'Minutes', 'minutes')],
  params: [{ key: 'month', type: 'month', default: 'this_month', description: 'Month (YYYY-MM)' }] },
  { key: 'leave', label: 'Leave requests', description: 'Leave requests by person and type.', module: 'hr', entity: 'leave_request', columns: [
    c('id', 'Request id', 'id', { ref: 'leave_request' }), c('userId', 'User id', 'id', { ref: 'user' }), c('userName', 'User', 'text'), c('leaveType', 'Leave type', 'text'), c('fromDate', 'From', 'date'),
    c('toDate', 'To', 'date'), c('days', 'Days', 'number'), c('approvedDays', 'Approved days', 'number'), c('status', 'Status', 'enum', { values: LEAVE_STATUSES })] },
  { key: 'expenses', label: 'Expense claims', description: 'Staff expense claims and their approval/payment.', module: 'hr', entity: 'expense_claim', columns: [
    c('id', 'Claim id', 'id', { ref: 'expense_claim' }), c('userId', 'User id', 'id', { ref: 'user' }), c('userName', 'User', 'text'), c('title', 'Claim', 'text'), c('status', 'Status', 'enum', { values: EXPENSE_STATUSES }),
    c('submittedAt', 'Submitted at', 'datetime'), c('submittedMonth', 'Month', 'text'), c('claimedPaise', 'Claimed', 'paise'), c('approvedPaise', 'Approved', 'paise'), c('paidPaise', 'Paid', 'paise')] },
  { key: 'dsc', label: 'DSC register', description: 'Digital signature certificates with expiry and custody.', module: 'dsc', entity: 'dsc', columns: [
    c('id', 'DSC id', 'id', { ref: 'dsc' }), c('holderName', 'Holder', 'text'), c('holderKind', 'Holder kind', 'text'), ...clientCols, c('dscClass', 'Class', 'text'), c('issuer', 'Issuer', 'text'),
    c('validTo', 'Valid to', 'date'), c('daysToExpiry', 'Days to expiry', 'int'), c('custody', 'Custody', 'enum', { values: DSC_CUSTODY })] },
  { key: 'licences', label: 'Licences', description: 'Client licences/registrations with renewal dates.', module: 'compliance', entity: 'licence', columns: [
    c('id', 'Licence id', 'id', { ref: 'licence' }), ...clientCols, c('licenceType', 'Licence', 'text'), c('number', 'Number', 'text'), c('authority', 'Authority', 'text'), c('validTo', 'Valid to', 'date'),
    c('renewalDue', 'Renewal due', 'date'), c('daysToRenewal', 'Days to renewal', 'int'), c('status', 'Status', 'text')] },
  { key: 'automation_runs', label: 'Automation runs', description: 'Rule runs with status and metered cost.', module: 'automation', entity: 'automation_run', columns: [
    c('id', 'Run id', 'id', { ref: 'automation_run' }), c('ruleId', 'Rule id', 'id', { ref: 'automation_rule' }), c('ruleName', 'Rule', 'text'), c('status', 'Status', 'enum', { values: RUN_STATUSES }), c('step', 'Step', 'text'),
    c('startedAt', 'Started at', 'datetime'), c('startedMonth', 'Month', 'text'), c('actionsTotal', 'Actions', 'int'), c('actionsDone', 'Actions done', 'int'), c('costPaise', 'Cost', 'paise')] },
  { key: 'ai_usage', label: 'AI usage', description: 'AI calls: tokens and metered cost per feature/user/month.', module: 'ai', columns: [
    c('feature', 'Feature', 'text'), c('userId', 'User id', 'id', { ref: 'user' }), c('userName', 'User', 'text'), c('provider', 'Provider', 'text'), c('model', 'Model', 'text'), c('month', 'Month', 'text'),
    c('inputTokens', 'Input tokens', 'int'), c('outputTokens', 'Output tokens', 'int'), c('costPaise', 'Cost', 'paise')] },
];
export const datasetMeta = (key: string): DatasetMeta | undefined => DATASETS.find((d) => d.key === key);
export const columnMeta = (ds: DatasetMeta, key: string): ColumnMeta | undefined => ds.columns.find((x) => x.key === key);

// ---------- Definition schema ----------
export const FILTER_OPS = ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'starts_with', 'is_null', 'not_null', 'fy', 'period'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const AGG_FNS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type AggFn = (typeof AGG_FNS)[number];
export const CHART_TYPES = ['table', 'bar', 'line', 'pie', 'kpi'] as const;
export const REPORT_LIMITS = { maxColumns: 30, maxFilters: 20, maxGroupBy: 2, maxAggregates: 10, maxRows: 10_000, maxPageSize: 500, maxGroups: 1000 } as const;

const colKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/, 'Unknown column');
const alias = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/);
const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
export const reportFilterSchema = z.object({ column: colKey, op: z.enum(FILTER_OPS), value: z.union([scalar, z.null(), z.array(z.union([z.string().max(200), z.number().finite()])).max(100)]).optional() }).strict();
export const reportAggregateSchema = z.object({ fn: z.enum(AGG_FNS), column: colKey.optional(), as: alias.optional() }).strict();
export const reportDefinitionSchema = z.object({
  dataset: z.string().regex(/^[a-z_]{2,40}$/, 'Unknown dataset'),
  columns: z.array(colKey).max(REPORT_LIMITS.maxColumns).default([]),
  filters: z.array(reportFilterSchema).max(REPORT_LIMITS.maxFilters).default([]),
  groupBy: z.array(colKey).max(REPORT_LIMITS.maxGroupBy).default([]),
  aggregates: z.array(reportAggregateSchema).max(REPORT_LIMITS.maxAggregates).default([]),
  sort: z.array(z.object({ by: alias, dir: z.enum(['asc', 'desc']).default('asc') }).strict()).max(3).default([]),
  limit: z.number().int().min(1).max(REPORT_LIMITS.maxRows).optional(),
  params: z.record(z.string().regex(/^[a-zA-Z]{1,20}$/), z.union([z.string().max(40), z.number().int()])).default({}),
  chart: z.object({ type: z.enum(CHART_TYPES), x: alias.optional(), y: alias.optional() }).strict().optional(),
}).strict();
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export type ReportFilter = z.infer<typeof reportFilterSchema>;
export type ReportAggregate = z.infer<typeof reportAggregateSchema> & { as: string };
export const aggAlias = (a: { fn: AggFn; column?: string; as?: string }) => a.as ?? (a.fn === 'count' && !a.column ? 'count' : `${a.fn}_${a.column}`);

const OPS_BY_TYPE: Record<ColumnType, readonly FilterOp[]> = {
  text: ['eq', 'neq', 'in', 'nin', 'contains', 'starts_with', 'is_null', 'not_null'],
  id: ['eq', 'neq', 'in', 'nin', 'is_null', 'not_null'],
  enum: ['eq', 'neq', 'in', 'nin', 'is_null', 'not_null'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null', 'fy', 'period'],
  datetime: ['gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null', 'fy', 'period'],
  int: ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
  paise: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
  minutes: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
  bool: ['eq', 'neq', 'is_null', 'not_null'],
};
export const opsFor = (t: ColumnType) => OPS_BY_TYPE[t];

// ---------- FY / periods (IST) ----------
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (s: string) => ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const monthEndIso = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const shiftMonth = (ym: string, k: number) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
const fyStartOf = (iso: string) => { const [y, m] = iso.split('-').map(Number) as [number, number]; return m >= 4 ? y : y - 1; };

/** "2025-26", "FY 25-26", "FY2025-26", "25-26", "2025" → Indian FY 1 Apr – 31 Mar. Null when unparseable. */
export function parseFy(label: string): { from: string; to: string; label: string; startYear: number } | null {
  const m = /^\s*(?:FY\s*)?(\d{2}|\d{4})(?:\s*[-/–]\s*(\d{2}|\d{4}))?\s*$/i.exec(label);
  if (!m) return null;
  let start = Number(m[1]); if (m[1]!.length === 2) start += 2000;
  if (m[2]) { let end = Number(m[2]); if (m[2].length === 2) end += Math.floor(start / 100) * 100; if (end !== start + 1) return null; }
  if (start < 2000 || start > 2100) return null;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, startYear: start };
}

export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_fy', 'last_fy',
  'last_7_days', 'last_30_days', 'last_90_days', 'next_7_days', 'next_30_days', 'next_60_days', 'next_90_days'] as const;
export type Period = (typeof PERIODS)[number];
/** A named period, `month:YYYY-MM` or `fy:2025-26`, resolved against `today` (IST yyyy-mm-dd). Inclusive range. */
export function periodRange(spec: string, today: string): { from: string; to: string } | null {
  if (!validIso(today)) return null;
  const ym = today.slice(0, 7);
  const q0 = (() => { const m = Number(today.slice(5, 7)); const qm = Math.floor((m - 1) / 3) * 3 + 1; return `${today.slice(0, 4)}-${String(qm).padStart(2, '0')}`; })();
  const mm = /^month:(\d{4}-(0[1-9]|1[0-2]))$/.exec(spec);
  if (mm) return { from: `${mm[1]}-01`, to: monthEndIso(mm[1]!) };
  const fm = /^fy:(.+)$/.exec(spec);
  if (fm) { const f = parseFy(fm[1]!); return f && { from: f.from, to: f.to }; }
  switch (spec as Period) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDaysIso(today, -1); return { from: y, to: y }; }
    case 'this_week': { const m = mondayOf(today); return { from: m, to: addDaysIso(m, 6) }; }
    case 'last_week': { const m = addDaysIso(mondayOf(today), -7); return { from: m, to: addDaysIso(m, 6) }; }
    case 'this_month': return { from: `${ym}-01`, to: monthEndIso(ym) };
    case 'last_month': { const p = shiftMonth(ym, -1); return { from: `${p}-01`, to: monthEndIso(p) }; }
    case 'this_quarter': return { from: `${q0}-01`, to: monthEndIso(shiftMonth(q0, 2)) };
    case 'last_quarter': { const p = shiftMonth(q0, -3); return { from: `${p}-01`, to: monthEndIso(shiftMonth(p, 2)) }; }
    case 'this_fy': { const s = fyStartOf(today); return { from: `${s}-04-01`, to: `${s + 1}-03-31` }; }
    case 'last_fy': { const s = fyStartOf(today) - 1; return { from: `${s}-04-01`, to: `${s + 1}-03-31` }; }
    case 'last_7_days': return { from: addDaysIso(today, -6), to: today };
    case 'last_30_days': return { from: addDaysIso(today, -29), to: today };
    case 'last_90_days': return { from: addDaysIso(today, -89), to: today };
    case 'next_7_days': return { from: today, to: addDaysIso(today, 7) };
    case 'next_30_days': return { from: today, to: addDaysIso(today, 30) };
    case 'next_60_days': return { from: today, to: addDaysIso(today, 60) };
    case 'next_90_days': return { from: today, to: addDaysIso(today, 90) };
    default: return null;
  }
}

/** Dataset parameter defaults ('today', 'fy_start', 'week_start', 'weeks_back_3', 'month_start', 'month_end', 'this_month') resolved in IST. */
export function resolveParams(ds: DatasetMeta, given: Record<string, string | number>, today: string): { params: Record<string, string | number>; issues: string[] } {
  const out: Record<string, string | number> = {}; const issues: string[] = [];
  for (const k of Object.keys(given)) if (!(ds.params ?? []).some((p) => p.key === k)) issues.push(`Unknown parameter ${k}`);
  for (const p of ds.params ?? []) {
    let v = given[p.key] ?? p.default;
    if (typeof v === 'string') {
      if (v === 'today') v = today;
      else if (v === 'fy_start') v = `${fyStartOf(today)}-04-01`;
      else if (v === 'week_start') v = mondayOf(today);
      else if (v === 'weeks_back_3') v = addDaysIso(mondayOf(today), -21);
      else if (v === 'month_start') v = `${today.slice(0, 7)}-01`;
      else if (v === 'month_end') v = monthEndIso(today.slice(0, 7));
      else if (v === 'this_month') v = today.slice(0, 7);
    }
    const bad = () => issues.push(`Invalid parameter ${p.key}`);
    if (p.type === 'date' && !(typeof v === 'string' && validIso(v))) bad();
    else if (p.type === 'month' && !(typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v))) bad();
    else if (p.type === 'int' && !(typeof v === 'number' && Number.isInteger(v) && v >= (p.min ?? -Infinity) && v <= (p.max ?? Infinity))) bad();
    else if (p.type === 'enum' && !(typeof v === 'string' && (p.values ?? []).includes(v))) bad();
    out[p.key] = v;
  }
  return { params: out, issues };
}

// ---------- Column access ----------
/** What the viewer may see of a dataset's columns: cost needs canSeeCost; any column with a hidden key follows role field hiding. */
export function hiddenColumns(ds: DatasetMeta, viewer: { canSeeCost: boolean; hiddenFields: string[] }): Set<string> {
  const hidden = new Set<string>();
  const hit = (key: string) => viewer.hiddenFields.some((f) => f === key || (f.endsWith('.*') && key.startsWith(f.slice(0, -1))));
  for (const col of ds.columns) {
    if (col.sensitivity === 'cost' && !viewer.canSeeCost) hidden.add(col.key);
    if (col.hiddenKey && hit(col.hiddenKey)) hidden.add(col.key);
  }
  return hidden;
}

// ---------- Validation ----------
export type ResolvedFilter = { column: string; op: Exclude<FilterOp, 'fy' | 'period'>; value?: unknown };
export type ValidDefinition = Omit<ReportDefinition, 'aggregates' | 'filters'> & { aggregates: ReportAggregate[]; filters: ReportFilter[]; resolved: ResolvedFilter[] };
export type ValidationResult = { ok: true; def: ValidDefinition; meta: DatasetMeta } | { ok: false; issues: string[] };

function checkValue(col: ColumnMeta, v: unknown): boolean {
  if (v === null || v === undefined) return false;
  switch (col.type) {
    case 'date': case 'datetime': return typeof v === 'string' && validIso(v);
    case 'int': case 'paise': case 'minutes': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'bool': return typeof v === 'boolean';
    case 'enum': return typeof v === 'string' && (col.values ?? []).includes(v);
    case 'id': return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
    default: return typeof v === 'string';
  }
}

/**
 * Validates a definition against the fixed catalogue (unknown dataset/columns, wrong op for the type, mistyped values,
 * non-numeric sums…) and resolves FY/period filters to date ranges for `today` (IST). Pure; the server runs it on every
 * definition it receives — from the builder, a saved report, a dashboard widget or the NL-query model.
 */
export function validateDefinition(raw: unknown, today: string): ValidationResult {
  const p = reportDefinitionSchema.safeParse(raw);
  if (!p.success) return { ok: false, issues: p.error.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`) };
  const d = p.data; const issues: string[] = [];
  const meta = datasetMeta(d.dataset);
  if (!meta) return { ok: false, issues: [`Unknown dataset ${d.dataset}`] };
  const col = (k: string, where: string) => { const m = columnMeta(meta, k); if (!m) issues.push(`${where}: unknown column ${k}`); return m; };
  for (const k of d.columns) col(k, 'columns');
  if (new Set(d.columns).size !== d.columns.length) issues.push('columns: duplicate column');
  for (const k of d.groupBy) col(k, 'groupBy');
  if (new Set(d.groupBy).size !== d.groupBy.length) issues.push('groupBy: duplicate column');
  const resolved: ResolvedFilter[] = [];
  for (const f of d.filters) {
    const m = col(f.column, 'filters'); if (!m) continue;
    if (!OPS_BY_TYPE[m.type].includes(f.op)) { issues.push(`filters: ${f.op} not allowed on ${m.type} column ${f.column}`); continue; }
    const v = f.value;
    if (f.op === 'is_null' || f.op === 'not_null') { resolved.push({ column: f.column, op: f.op }); continue; }
    if (f.op === 'fy' || f.op === 'period') {
      const r = typeof v === 'string' ? (f.op === 'fy' ? parseFy(v) : periodRange(v, today)) : null;
      if (!r) { issues.push(`filters: invalid ${f.op} for ${f.column}`); continue; }
      resolved.push({ column: f.column, op: 'between', value: [r.from, r.to] }); continue;
    }
    if (f.op === 'in' || f.op === 'nin') {
      if (!Array.isArray(v) || !v.length || !v.every((x) => checkValue(m, x))) { issues.push(`filters: ${f.op} needs a list of ${m.type} values for ${f.column}`); continue; }
    } else if (f.op === 'between') {
      if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => checkValue(m, x))) { issues.push(`filters: between needs [from, to] for ${f.column}`); continue; }
    } else if (f.op === 'contains' || f.op === 'starts_with') {
      if (typeof v !== 'string' || !v.length) { issues.push(`filters: ${f.op} needs text for ${f.column}`); continue; }
    } else if (!checkValue(m, v)) { issues.push(`filters: invalid value for ${f.column}`); continue; }
    resolved.push({ column: f.column, op: f.op, value: v });
  }
  const aggs: ReportAggregate[] = [];
  for (const a of d.aggregates) {
    if (a.fn !== 'count' && !a.column) { issues.push(`aggregates: ${a.fn} needs a column`); continue; }
    if (a.column) {
      const m = col(a.column, 'aggregates'); if (!m) continue;
      if ((a.fn === 'sum' || a.fn === 'avg') && !NUMERIC_TYPES.includes(m.type)) { issues.push(`aggregates: ${a.fn} needs a numeric column (${a.column})`); continue; }
      if ((a.fn === 'min' || a.fn === 'max') && !NUMERIC_TYPES.includes(m.type) && m.type !== 'date') { issues.push(`aggregates: ${a.fn} needs a numeric or date column (${a.column})`); continue; }
    }
    aggs.push({ ...a, as: aggAlias(a) });
  }
  if (new Set(aggs.map((a) => a.as)).size !== aggs.length) issues.push('aggregates: duplicate alias');
  if (d.groupBy.length && !aggs.length) aggs.push({ fn: 'count', as: 'count' });
  const sortable = new Set([...meta.columns.map((x) => x.key), ...aggs.map((a) => a.as)]);
  for (const s of d.sort) if (!sortable.has(s.by)) issues.push(`sort: unknown column ${s.by}`);
  for (const k of ['x', 'y'] as const) { const v = d.chart?.[k]; if (v && !sortable.has(v)) issues.push(`chart.${k}: unknown column ${v}`); }
  const pr = resolveParams(meta, d.params, today);
  issues.push(...pr.issues);
  if (issues.length) return { ok: false, issues };
  const columns = d.columns.length ? d.columns : meta.columns.filter((x) => x.type !== 'id').slice(0, 8).map((x) => x.key);
  return { ok: true, meta, def: { ...d, columns, aggregates: aggs, params: pr.params, resolved } };
}

/** Every column the definition touches (selection, filters, grouping, aggregates, sort, chart). */
export function referencedColumns(d: Pick<ValidDefinition, 'columns' | 'filters' | 'groupBy' | 'aggregates' | 'sort' | 'chart'>, meta: DatasetMeta): string[] {
  const keys = new Set([...d.columns, ...d.filters.map((f) => f.column), ...d.groupBy, ...d.aggregates.flatMap((a) => (a.column ? [a.column] : [])), ...d.sort.map((s) => s.by)]);
  for (const k of [d.chart?.x, d.chart?.y]) if (k) keys.add(k);
  return [...keys].filter((k) => !!columnMeta(meta, k));
}

// ---------- SQL compilation (pure; parameterised) ----------
export type SqlColumn = { expr: string; type: ColumnType };
const castOf = (t: ColumnType) => (t === 'date' || t === 'datetime' ? 'date' : t === 'int' || t === 'paise' || t === 'minutes' ? 'bigint' : t === 'number' ? 'numeric' : t === 'bool' ? 'boolean' : 'text');
/**
 * WHERE fragments for resolved filters over whitelisted column expressions. Values only ever travel as parameters
 * (`add(value)` returns `$n`); column expressions come from the server's dataset registry, never from the definition.
 * Datetime columns compare on their IST calendar date.
 */
export function compileFilters(filters: ResolvedFilter[], colOf: (key: string) => SqlColumn | undefined, add: (v: unknown) => string): string[] {
  const out: string[] = [];
  for (const f of filters) {
    const cdef = colOf(f.column); if (!cdef) continue;
    const cast = castOf(cdef.type);
    const e = cdef.type === 'datetime' ? `((${cdef.expr}) AT TIME ZONE 'Asia/Kolkata')::date` : cdef.type === 'id' ? `(${cdef.expr})::text` : `(${cdef.expr})`;
    const v = (x: unknown) => `${add(x)}::${cast}`;
    switch (f.op) {
      case 'eq': out.push(`${e} = ${v(f.value)}`); break;
      case 'neq': out.push(`${e} IS DISTINCT FROM ${v(f.value)}`); break;
      case 'in': out.push(`${e} = ANY(${add(f.value)}::${cast}[])`); break;
      case 'nin': out.push(`(${e} IS NULL OR NOT (${e} = ANY(${add(f.value)}::${cast}[])))`); break;
      case 'gt': out.push(`${e} > ${v(f.value)}`); break;
      case 'gte': out.push(`${e} >= ${v(f.value)}`); break;
      case 'lt': out.push(`${e} < ${v(f.value)}`); break;
      case 'lte': out.push(`${e} <= ${v(f.value)}`); break;
      case 'between': { const [a, b] = f.value as [unknown, unknown]; out.push(`${e} BETWEEN ${v(a)} AND ${v(b)}`); break; }
      case 'contains': out.push(`strpos(lower(${e}), lower(${add(f.value)}::text)) > 0`); break;
      case 'starts_with': { const ph = add(f.value); out.push(`left(lower(${e}), length(${ph}::text)) = lower(${ph}::text)`); break; }
      case 'is_null': out.push(`${e} IS NULL`); break;
      case 'not_null': out.push(`${e} IS NOT NULL`); break;
    }
  }
  return out;
}

// ---------- In-memory evaluation (derived/service datasets, grouping) ----------
export type ReportRow = Record<string, unknown>;
const cmpVal = (col: ColumnMeta | undefined, x: unknown): unknown => (col?.type === 'datetime' && typeof x === 'string' ? istDate(new Date(x)) : x);
/** The same semantics as `compileFilters`, for rows already in memory. */
export function matchesFilters(row: ReportRow, filters: ResolvedFilter[], meta: DatasetMeta): boolean {
  return filters.every((f) => {
    const col = columnMeta(meta, f.column);
    const x = cmpVal(col, row[f.column]);
    const v = f.value as never;
    const nil = x === null || x === undefined;
    switch (f.op) {
      case 'is_null': return nil;
      case 'not_null': return !nil;
      case 'eq': return !nil && x === v;
      case 'neq': return x !== v;
      case 'in': return !nil && (v as unknown[]).includes(x);
      case 'nin': return nil || !(v as unknown[]).includes(x);
      case 'gt': return !nil && (x as number) > v;
      case 'gte': return !nil && (x as number) >= v;
      case 'lt': return !nil && (x as number) < v;
      case 'lte': return !nil && (x as number) <= v;
      case 'between': { const [a, b] = v as [never, never]; return !nil && (x as number) >= a && (x as number) <= b; }
      case 'contains': return !nil && String(x).toLowerCase().includes(String(v).toLowerCase());
      case 'starts_with': return !nil && String(x).toLowerCase().startsWith(String(v).toLowerCase());
    }
  });
}

export type AggValues = Record<string, number | string | null>;
/** Aggregates over rows. Sums of paise/int/minutes stay integers; avg of those is rounded half away from zero to an integer. */
export function aggregate(rows: ReportRow[], aggs: ReportAggregate[], meta: DatasetMeta): AggValues {
  const out: AggValues = {};
  for (const a of aggs) {
    const col = a.column ? columnMeta(meta, a.column) : undefined;
    const vals = a.column ? rows.map((r) => r[a.column!]).filter((v) => v !== null && v !== undefined) : rows;
    if (a.fn === 'count') { out[a.as] = vals.length; continue; }
    if (a.fn === 'min' || a.fn === 'max') {
      if (!vals.length) { out[a.as] = null; continue; }
      const s = [...vals].sort((x, y) => ((x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0));
      out[a.as] = (a.fn === 'min' ? s[0] : s[s.length - 1]) as number | string; continue;
    }
    const nums = vals.map(Number);
    const sum = nums.reduce((s, x) => s + x, 0);
    const integer = col && col.type !== 'number';
    if (a.fn === 'sum') out[a.as] = integer ? Math.round(sum) : Math.round(sum * 1000) / 1000;
    else out[a.as] = nums.length ? (integer ? Math.sign(sum) * Math.round(Math.abs(sum) / nums.length) : Math.round((sum / nums.length) * 1000) / 1000) : null;
  }
  return out;
}

export type ReportGroup = { key: Record<string, unknown>; label: string; values: AggValues; children?: ReportGroup[] };
const sortKey = (v: unknown) => (v === null || v === undefined ? '￿' : typeof v === 'number' ? v : String(v).toLowerCase());
const compare = (x: unknown, y: unknown) => {
  const nx = x === null || x === undefined; const ny = y === null || y === undefined;
  if (nx || ny) return nx === ny ? 0 : nx ? 1 : -1; // nulls last, whatever the direction
  const a = sortKey(x); const b = sortKey(y);
  return a < b ? -1 : a > b ? 1 : 0;
};
/** Stable multi-key sort; nulls always last. */
export function sortRows<T>(rows: T[], sort: Array<{ by: string; dir: 'asc' | 'desc' }>, get: (r: T, k: string) => unknown): T[] {
  if (!sort.length) return rows;
  return rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => {
    for (const s of sort) {
      const va = get(a, s.by); const vb = get(b, s.by);
      const nullish = va === null || va === undefined || vb === null || vb === undefined;
      const c0 = compare(va, vb);
      if (c0) return nullish ? c0 : s.dir === 'desc' ? -c0 : c0;
    }
    return i - j;
  }).map(([r]) => r);
}

/** ≤2-level grouping with aggregates per group; groups sorted by the definition's sort (keys or aliases), else by key. */
export function groupRows(rows: ReportRow[], d: Pick<ValidDefinition, 'groupBy' | 'aggregates' | 'sort'>, meta: DatasetMeta): ReportGroup[] {
  const level = (rs: ReportRow[], depth: number): ReportGroup[] => {
    const k = d.groupBy[depth]; if (!k) return [];
    const by = new Map<string, ReportRow[]>();
    for (const r of rs) { const id = JSON.stringify(r[k] ?? null); by.set(id, [...(by.get(id) ?? []), r]); }
    const groups = [...by.entries()].map(([id, members]) => {
      const v = JSON.parse(id) as unknown;
      const g: ReportGroup = { key: { [k]: v }, label: v === null ? '(none)' : String(v), values: aggregate(members, d.aggregates, meta) };
      if (d.groupBy[depth + 1]) g.children = level(members, depth + 1).map((ch) => ({ ...ch, key: { [k]: v, ...ch.key } }));
      return g;
    });
    const ord = d.sort.filter((s) => s.by === k || d.aggregates.some((a) => a.as === s.by));
    // Enum keys sort in their declared order (ageing buckets, stages…), others alphabetically.
    const values = columnMeta(meta, k)?.values;
    const keyOf = (g: ReportGroup) => { const v = g.key[k]; return values && typeof v === 'string' && values.includes(v) ? values.indexOf(v) : v; };
    return sortRows(sortRows(groups, [{ by: k, dir: 'asc' }], (g) => keyOf(g)), ord, (g, key) => (key === k ? keyOf(g) : g.values[key]));
  };
  return level(rows, 0);
}

/** Drill-down: the same definition restricted to one group (eq / is_null per key), ungrouped → the underlying rows. */
export function drillDefinition(full: ReportDefinition | ValidDefinition, key: Record<string, unknown>): ReportDefinition {
  const { resolved: _resolved, ...d } = full as ValidDefinition;
  const extra: ReportFilter[] = Object.entries(key).map(([column, v]) => (v === null || v === undefined ? { column, op: 'is_null' as const } : { column, op: 'eq' as const, value: v as string | number | boolean }));
  return { ...d, filters: [...d.filters, ...extra], groupBy: [], sort: d.sort.filter((s) => !d.aggregates.some((a) => aggAlias(a) === s.by)), limit: undefined, chart: undefined };
}

// ---------- Human-readable explanation (NL query "sources", builder preview) ----------
const OP_TEXT: Record<FilterOp, string> = { eq: 'is', neq: 'is not', in: 'is one of', nin: 'is not one of', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between', contains: 'contains',
  starts_with: 'starts with', is_null: 'is empty', not_null: 'is set', fy: 'is in FY', period: 'is in' };
export function explainDefinition(d: ReportDefinition): string {
  const meta = datasetMeta(d.dataset); if (!meta) return d.dataset;
  const aggLabel = (k: string) => { const a = d.aggregates.find((x) => aggAlias(x) === k); return a && (a.fn === 'count' && !a.column ? 'count' : `${a.fn} of ${columnMeta(meta, a.column!)?.label ?? a.column}`); };
  const L = (k: string) => columnMeta(meta, k)?.label ?? aggLabel(k) ?? k;
  const val = (v: unknown) => (Array.isArray(v) ? v.join(v.length === 2 ? ' and ' : ', ') : typeof v === 'string' ? v.replace(/_/g, ' ') : String(v));
  const parts = [`${meta.label}`];
  if (d.filters.length) parts.push(`where ${d.filters.map((f) => `${L(f.column)} ${OP_TEXT[f.op]}${f.value === undefined ? '' : ` ${val(f.value)}`}`).join(' and ')}`);
  if (d.groupBy.length) parts.push(`grouped by ${d.groupBy.map(L).join(', then ')}`);
  const aggs = d.aggregates.map((a) => (a.fn === 'count' && !a.column ? 'count' : `${a.fn} of ${L(a.column!)}`));
  if (aggs.length) parts.push(`showing ${aggs.join(', ')}`);
  if (d.sort.length) parts.push(`sorted by ${d.sort.map((s) => `${L(s.by)}${s.dir === 'desc' ? ' (high to low)' : ''}`).join(', ')}`);
  if (d.limit) parts.push(`top ${d.limit}`);
  return parts.join(', ');
}

// ---------- Schedules (IST) ----------
export const reportScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
  /** ISO weekday 1 = Monday (weekly). */
  weekday: z.number().int().min(1).max(7).default(1),
  /** 1–28 so every month has it (monthly). */
  dayOfMonth: z.number().int().min(1).max(28).default(1),
}).strict();
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;
const istAt = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);
/** Next occurrence strictly after `after` (IST wall clock). */
export function nextScheduleRun(s: ReportSchedule, after: Date): Date {
  let day = istDate(after);
  for (let i = 0; i < 400; i++, day = addDaysIso(day, 1)) {
    const wd = ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const ok = s.frequency === 'daily' || (s.frequency === 'weekly' && wd === s.weekday) || (s.frequency === 'monthly' && Number(day.slice(8)) === s.dayOfMonth);
    if (ok && istAt(day, s.time) > after) return istAt(day, s.time);
  }
  throw new Error('no schedule occurrence');
}
/** Idempotency period of an occurrence: the IST day (daily), its ISO week's Monday (weekly) or month (monthly). */
export function schedulePeriodKey(s: ReportSchedule, occurrence: Date): string {
  const day = istDate(occurrence);
  return s.frequency === 'daily' ? day : s.frequency === 'weekly' ? `W${mondayOf(day)}` : day.slice(0, 7);
}

// ---------- Dashboards ----------
export const WIDGET_KINDS = ['kpi', 'chart', 'table'] as const;
export const widgetSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  kind: z.enum(WIDGET_KINDS),
  title: z.string().trim().min(1).max(120),
  reportId: z.string().uuid().optional(),
  catalogueKey: z.string().regex(/^[a-z0-9_]{2,60}$/).optional(),
  params: z.record(z.string().regex(/^[a-zA-Z]{1,20}$/), z.union([z.string().max(40), z.number().int()])).optional(),
  /** KPI tile: the aggregate alias to show (default: first aggregate). */
  value: alias.optional(),
  chart: z.enum(CHART_TYPES).optional(),
  size: z.object({ w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(12) }).strict().optional(),
}).strict().refine((w) => !!w.reportId !== !!w.catalogueKey, { message: 'Give reportId or catalogueKey', path: ['reportId'] });
export type DashboardWidget = z.infer<typeof widgetSchema>;
export const dashboardWidgetsSchema = z.array(widgetSchema).max(24).refine((ws) => new Set(ws.map((w) => w.id)).size === ws.length, 'Duplicate widget id');

// ---------- Built-in catalogue (data) ----------
export type CatalogueReport = { key: string; name: string; description: string; definition: ReportDefinition };
const def = (d: Partial<ReportDefinition> & { dataset: string }): ReportDefinition => reportDefinitionSchema.parse(d);
export const REPORT_CATALOGUE: readonly CatalogueReport[] = [
  { key: 'unbilled_by_client', name: 'Unbilled by client', description: 'Done-but-unbilled work and suggested fees per client.',
    definition: def({ dataset: 'unbilled', columns: ['clientName', 'title', 'serviceName', 'completedOn', 'suggestedPaise'], groupBy: ['clientName'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'suggestedPaise' }], sort: [{ by: 'sum_suggestedPaise', dir: 'desc' }], chart: { type: 'bar', x: 'clientName', y: 'sum_suggestedPaise' } }) },
  { key: 'unbilled_by_service', name: 'Unbilled by service', description: 'Unbilled work per service.',
    definition: def({ dataset: 'unbilled', columns: ['serviceName', 'clientName', 'title', 'suggestedPaise'], groupBy: ['serviceName'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'suggestedPaise' }], sort: [{ by: 'sum_suggestedPaise', dir: 'desc' }], chart: { type: 'bar' } }) },
  { key: 'unbilled_by_user', name: 'Unbilled by user', description: 'Unbilled work per assignee.',
    definition: def({ dataset: 'unbilled', columns: ['assigneeName', 'clientName', 'title', 'suggestedPaise'], groupBy: ['assigneeName'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'suggestedPaise' }], chart: { type: 'bar' } }) },
  { key: 'ageing_buckets', name: 'Receivables ageing', description: 'Outstanding by days-past-due bucket (reconciles with Billing → Ageing).',
    definition: def({ dataset: 'ageing', columns: ['clientName', 'bucket', 'balancePaise'], groupBy: ['bucket'], aggregates: [{ fn: 'sum', column: 'balancePaise' }], chart: { type: 'bar', x: 'bucket', y: 'sum_balancePaise' } }) },
  { key: 'collections_by_month', name: 'Collections by month', description: 'Receipts per month this FY.',
    definition: def({ dataset: 'receipts', columns: ['receivedOn', 'number', 'clientName', 'mode', 'amountPaise'], filters: [{ column: 'receivedOn', op: 'period', value: 'this_fy' }], groupBy: ['receivedMonth'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'amountPaise' }, { fn: 'sum', column: 'tdsPaise' }], chart: { type: 'line', x: 'receivedMonth', y: 'sum_amountPaise' } }) },
  { key: 'revenue_by_service', name: 'Revenue by service', description: 'Taxable value of issued invoices this FY per service.',
    definition: def({ dataset: 'invoice_lines', columns: ['serviceName', 'number', 'clientName', 'taxablePaise'], filters: [{ column: 'kind', op: 'eq', value: 'invoice' }, { column: 'status', op: 'nin', value: ['draft', 'cancelled'] }, { column: 'reimbursement', op: 'eq', value: false }, { column: 'issueDate', op: 'period', value: 'this_fy' }], groupBy: ['serviceName'], aggregates: [{ fn: 'sum', column: 'taxablePaise' }], sort: [{ by: 'sum_taxablePaise', dir: 'desc' }], chart: { type: 'pie' } }) },
  { key: 'revenue_by_partner', name: 'Revenue by partner', description: 'Taxable value of issued invoices this FY per client partner.',
    definition: def({ dataset: 'invoice_lines', columns: ['partnerName', 'clientName', 'taxablePaise'], filters: [{ column: 'kind', op: 'eq', value: 'invoice' }, { column: 'status', op: 'nin', value: ['draft', 'cancelled'] }, { column: 'reimbursement', op: 'eq', value: false }, { column: 'issueDate', op: 'period', value: 'this_fy' }], groupBy: ['partnerName'], aggregates: [{ fn: 'sum', column: 'taxablePaise' }], chart: { type: 'bar' } }) },
  { key: 'revenue_by_branch', name: 'Revenue by branch', description: 'Taxable value of issued invoices this FY per branch.',
    definition: def({ dataset: 'invoice_lines', columns: ['branchName', 'clientName', 'taxablePaise'], filters: [{ column: 'kind', op: 'eq', value: 'invoice' }, { column: 'status', op: 'nin', value: ['draft', 'cancelled'] }, { column: 'reimbursement', op: 'eq', value: false }, { column: 'issueDate', op: 'period', value: 'this_fy' }], groupBy: ['branchName'], aggregates: [{ fn: 'sum', column: 'taxablePaise' }], chart: { type: 'bar' } }) },
  { key: 'job_pnl', name: 'Job P&L', description: 'Revenue, cost, WIP and margin per client this FY (cost and margin need cost visibility).',
    definition: def({ dataset: 'job_pnl', columns: ['label', 'revenuePaise', 'costPaise', 'wipPaise', 'marginPaise', 'marginPct', 'minutes'], aggregates: [{ fn: 'sum', column: 'revenuePaise' }, { fn: 'sum', column: 'costPaise' }, { fn: 'sum', column: 'wipPaise' }, { fn: 'sum', column: 'minutes' }], sort: [{ by: 'revenuePaise', dir: 'desc' }], chart: { type: 'table' } }) },
  { key: 'utilisation_by_user', name: 'Utilisation by user', description: 'Capacity, planned and actual minutes per person × week (reconciles with Time → Capacity).',
    definition: def({ dataset: 'capacity', columns: ['userName', 'weekStart', 'capacityMinutes', 'plannedMinutes', 'actualMinutes', 'actualPct'], groupBy: ['userName'], aggregates: [{ fn: 'sum', column: 'capacityMinutes' }, { fn: 'sum', column: 'plannedMinutes' }, { fn: 'sum', column: 'actualMinutes' }], chart: { type: 'bar', x: 'userName', y: 'sum_actualMinutes' } }) },
  { key: 'capacity_by_week', name: 'Team capacity by week', description: 'Planned vs capacity per week.',
    definition: def({ dataset: 'capacity', columns: ['weekStart', 'userName', 'capacityMinutes', 'plannedMinutes', 'actualMinutes'], groupBy: ['weekStart'], aggregates: [{ fn: 'sum', column: 'capacityMinutes' }, { fn: 'sum', column: 'plannedMinutes' }, { fn: 'sum', column: 'actualMinutes' }], chart: { type: 'line' } }) },
  { key: 'overdue_tasks_by_assignee', name: 'Overdue tasks by assignee', description: 'Open tasks past their act-by/statutory date, per assignee.',
    definition: def({ dataset: 'tasks', columns: ['assigneeName', 'clientName', 'title', 'statutoryDue', 'daysOverdue'], filters: [{ column: 'overdue', op: 'eq', value: true }], groupBy: ['assigneeName'], aggregates: [{ fn: 'count' }, { fn: 'max', column: 'daysOverdue' }], sort: [{ by: 'count', dir: 'desc' }], chart: { type: 'bar' } }) },
  { key: 'my_open_tasks', name: 'My open tasks', description: 'Open tasks in your scope by status.',
    definition: def({ dataset: 'tasks', columns: ['title', 'clientName', 'status', 'statutoryDue', 'actBy'], filters: [{ column: 'status', op: 'nin', value: ['done', 'cancelled'] }], groupBy: ['status'], aggregates: [{ fn: 'count' }], sort: [{ by: 'statutoryDue', dir: 'asc' }], chart: { type: 'pie' } }) },
  { key: 'my_time_this_week', name: 'Time this week', description: 'Minutes logged this week per day.',
    definition: def({ dataset: 'time_entries', columns: ['workDate', 'clientName', 'taskTitle', 'minutes', 'billable', 'status'], filters: [{ column: 'workDate', op: 'period', value: 'this_week' }], groupBy: ['workDate'], aggregates: [{ fn: 'sum', column: 'minutes' }], chart: { type: 'bar' } }) },
  { key: 'compliance_status', name: 'Compliance status', description: 'Statutory items due this month by state (reconciles with Compliance → Matrix).',
    definition: def({ dataset: 'compliance', columns: ['clientName', 'form', 'periodLabel', 'statutoryDue', 'state'], groupBy: ['state'], aggregates: [{ fn: 'count' }], chart: { type: 'pie' } }) },
  { key: 'compliance_by_form', name: 'Compliance by form', description: 'Statutory items this month per form and state.',
    definition: def({ dataset: 'compliance', columns: ['form', 'state', 'clientName'], groupBy: ['form', 'state'], aggregates: [{ fn: 'count' }], chart: { type: 'bar' } }) },
  { key: 'notices_by_authority', name: 'Open notices by authority', description: 'Open notices and demand per authority and age.',
    definition: def({ dataset: 'notices', columns: ['authority', 'level', 'title', 'clientName', 'receivedOn', 'ageBucket', 'demandPaise'], filters: [{ column: 'status', op: 'neq', value: 'closed' }], groupBy: ['authority', 'ageBucket'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'demandPaise' }], chart: { type: 'bar' } }) },
  { key: 'leads_funnel', name: 'Leads funnel', description: 'Leads and expected value per stage.',
    definition: def({ dataset: 'leads', columns: ['name', 'company', 'stage', 'ownerName', 'expectedValuePaise'], groupBy: ['stage'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'expectedValuePaise' }], chart: { type: 'bar' } }) },
  { key: 'proposal_conversion', name: 'Proposal conversion', description: 'Proposals by outcome.',
    definition: def({ dataset: 'proposals', columns: ['number', 'title', 'leadName', 'status', 'sentAt'], groupBy: ['status'], aggregates: [{ fn: 'count' }], chart: { type: 'pie' } }) },
  { key: 'dsc_expiring', name: 'DSCs expiring (90 days)', description: 'DSCs whose validity ends in the next 90 days.',
    definition: def({ dataset: 'dsc', columns: ['holderName', 'clientName', 'dscClass', 'validTo', 'daysToExpiry', 'custody'], filters: [{ column: 'validTo', op: 'period', value: 'next_90_days' }], sort: [{ by: 'validTo', dir: 'asc' }], chart: { type: 'table' } }) },
  { key: 'licence_renewals', name: 'Licence renewals (90 days)', description: 'Licences due for renewal in the next 90 days.',
    definition: def({ dataset: 'licences', columns: ['clientName', 'licenceType', 'number', 'renewalDue', 'validTo', 'daysToRenewal'], filters: [{ column: 'validTo', op: 'period', value: 'next_90_days' }], sort: [{ by: 'validTo', dir: 'asc' }], chart: { type: 'table' } }) },
  { key: 'attendance_summary', name: 'Attendance summary', description: 'This month per person (reconciles with HR → Attendance report).',
    definition: def({ dataset: 'attendance', columns: ['userName', 'workingDays', 'presentDays', 'leaveDays', 'absentDays', 'flaggedDays'], aggregates: [{ fn: 'sum', column: 'presentDays' }, { fn: 'sum', column: 'leaveDays' }, { fn: 'sum', column: 'absentDays' }], chart: { type: 'table' } }) },
  { key: 'leave_by_type', name: 'Leave by type', description: 'Approved leave days this FY per type.',
    definition: def({ dataset: 'leave', columns: ['userName', 'leaveType', 'fromDate', 'toDate', 'approvedDays', 'status'], filters: [{ column: 'status', op: 'in', value: ['approved', 'partially_approved'] }, { column: 'fromDate', op: 'period', value: 'this_fy' }], groupBy: ['leaveType'], aggregates: [{ fn: 'sum', column: 'approvedDays' }], chart: { type: 'bar' } }) },
  { key: 'expense_claims', name: 'Expense claims', description: 'Claims by status this FY.',
    definition: def({ dataset: 'expenses', columns: ['userName', 'title', 'status', 'claimedPaise', 'approvedPaise', 'paidPaise'], groupBy: ['status'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'claimedPaise' }, { fn: 'sum', column: 'approvedPaise' }], chart: { type: 'bar' } }) },
  { key: 'automation_cost', name: 'Automation cost', description: 'Runs and metered cost per rule this month.',
    definition: def({ dataset: 'automation_runs', columns: ['ruleName', 'status', 'startedAt', 'costPaise'], filters: [{ column: 'startedAt', op: 'period', value: 'this_month' }], groupBy: ['ruleName'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'costPaise' }], chart: { type: 'bar' } }) },
  { key: 'ai_cost', name: 'AI usage & cost', description: 'AI calls, tokens and cost per feature.',
    definition: def({ dataset: 'ai_usage', columns: ['feature', 'month', 'userName', 'inputTokens', 'outputTokens', 'costPaise'], groupBy: ['feature'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'costPaise' }, { fn: 'sum', column: 'inputTokens' }, { fn: 'sum', column: 'outputTokens' }], chart: { type: 'pie' } }) },
];
export const catalogueReport = (key: string) => REPORT_CATALOGUE.find((r) => r.key === key);

/** Role-default dashboards (data; the demo seed and new firms start from these — firms edit them). */
export const ROLE_DASHBOARD_TEMPLATES: Record<string, { name: string; widgets: DashboardWidget[] }> = {
  partner: { name: 'Partner overview', widgets: [
    { id: 'unbilled', kind: 'kpi', title: 'Unbilled (suggested fees)', catalogueKey: 'unbilled_by_client', value: 'sum_suggestedPaise' },
    { id: 'ageing', kind: 'chart', title: 'Receivables ageing', catalogueKey: 'ageing_buckets', chart: 'bar' },
    { id: 'utilisation', kind: 'chart', title: 'Utilisation (4 weeks)', catalogueKey: 'utilisation_by_user', chart: 'bar' },
    { id: 'collections', kind: 'chart', title: 'Collections this FY', catalogueKey: 'collections_by_month', chart: 'line' },
    { id: 'compliance', kind: 'chart', title: 'Compliance this month', catalogueKey: 'compliance_status', chart: 'pie' },
  ] },
  manager: { name: 'Team overview', widgets: [
    { id: 'overdue', kind: 'chart', title: 'Team overdue tasks', catalogueKey: 'overdue_tasks_by_assignee', chart: 'bar' },
    { id: 'capacity', kind: 'chart', title: 'Capacity by week', catalogueKey: 'capacity_by_week', chart: 'line' },
    { id: 'overdue_count', kind: 'kpi', title: 'Overdue tasks', catalogueKey: 'overdue_tasks_by_assignee', value: 'count' },
  ] },
  article: { name: 'My work', widgets: [
    { id: 'tasks', kind: 'table', title: 'My open tasks', catalogueKey: 'my_open_tasks' },
    { id: 'time', kind: 'chart', title: 'My time this week', catalogueKey: 'my_time_this_week', chart: 'bar' },
  ] },
};
