import { HttpException, Injectable } from '@nestjs/common';
import {
  ACTION_PERMS, addDaysIso, aiGate, aiSettingsSchema, can, clientCtx, effectiveScope, maskAddress, normalizeAddress, renderAutomationText,
  type Action, type AutomationAction, type EventContext, type Module, type PersonRef, type TemplateCategory,
} from '@worko/domain';
import { createHash } from 'node:crypto';
import { AiService } from '../ai/ai.service.js';
import { envNoAi } from '../ai/provider.js';
import type { RequestActor } from '../auth/context.js';
import { InvoicesService } from '../billing/invoices.service.js';
import { visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { CommService } from '../comm/comm.service.js';
import { addressFor, checkSend, loadCommSettings, loadRates } from '../comm/common.js';
import { DbService, type Tx } from '../db/db.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { AuditWorkService } from '../practice/audit.service.js';
import { usersSeeing } from '../practice/common.js';
import { udinGateError } from '../practice/udin-gate.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { TasksService } from '../tasks/tasks.service.js';

export type RuleRow = { id: string; tenant_id: string; name: string; owner_id: string; scope: 'firm' | 'personal' };
export type ActionOutcome = { status: 'done' | 'queued' | 'refused' | 'failed' | 'skipped'; code?: string | null; result?: Record<string, unknown>; costPaise?: number; error?: string | null };
export type ActionPlan = { type: string; summary: string; wouldRefuse: string | null; costPaise: number; details: Record<string, unknown> };

/** Business refusals (rules working as intended) — recorded, never counted as failures. */
const REFUSALS = new Set(['opted_out', 'not_opted_in', 'over_cap', 'template_required', 'template_not_approved', 'no_address', 'udin_required', 'required_checks_pending',
  'reviewer_required', 'reviewer_must_approve', 'pending_issue_required', 'task_closed', 'task_not_done', 'invalid_transition', 'no_ai_mode', 'ai_disabled', 'feature_disabled', 'ai_cap', 'redaction_failed',
  'cost_cap', 'no_recipient', 'no_task', 'no_client', 'no_document', 'no_engagement', 'no_contact', 'exists', 'address_not_on_client', 'missing_variables', 'subject_required', 'task_not_billable', 'task_already_billed']);

export function classifyError(e: unknown): ActionOutcome {
  if (e instanceof HttpException) {
    const st = e.getStatus(); const body = e.getResponse() as { code?: string; message?: string } | string;
    const code = (typeof body === 'object' && body.code) || (st === 403 ? 'forbidden' : st === 404 ? 'not_found' : st === 409 ? 'conflict' : `http_${st}`);
    const msg = typeof body === 'object' ? String(body.message ?? e.message) : String(body);
    return { status: REFUSALS.has(code) || (st === 409 && code !== 'conflict') ? 'refused' : 'failed', code, error: msg.slice(0, 300) };
  }
  return { status: 'failed', code: 'error', error: String((e as Error)?.message ?? e).slice(0, 300) };
}
const refused = (code: string, error?: string): ActionOutcome => ({ status: 'refused', code, error: error ?? null });
const checkKey = (label: string) => `auto_${createHash('sha256').update(label).digest('hex').slice(0, 10)}`;
type Ctx = EventContext & { client?: Record<string, unknown>; task?: Record<string, unknown>; [k: string]: unknown };
const s = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Executes (and, for dry-runs, plans) one automation action by calling the owning service as the automation actor, so
 * every rule (UDIN gate, consent, quiet hours, caps, permissions) and audit entry applies exactly as for a person.
 */
@Injectable()
export class ActionRunner {
  constructor(private db: DbService, private clock: Clock, private realtime: RealtimeService, private tasks: TasksService, private comm: CommService,
    private work: AuditWorkService, private invoices: InvoicesService, private ai: AiService) {}

  person(ref: PersonRef, ctx: Ctx, rule: RuleRow): string | null {
    if (typeof ref === 'object') return ref.userId;
    const g = (path: string) => s(path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), ctx));
    switch (ref) {
      case 'owner': return rule.owner_id;
      case 'task_assignee': return g('task.assigneeId');
      case 'task_manager': return g('task.managerId');
      case 'client_partner': return g('client.partnerId');
      case 'client_manager': return g('client.managerId') ?? g('client.partnerId');
      case 'hearing_owner': return g('hearing.ownerId');
      case 'notice_assignee': return g('notice.assigneeId');
    }
  }
  private render(t: string, ctx: Ctx) { return renderAutomationText(t, ctx); }
  private clientOf(ctx: Ctx) { return s(ctx.client?.id); }
  private taskOf(ctx: Ctx) { return s(ctx.task?.id); }

  async execute(actor: RequestActor, rule: RuleRow, a: AutomationAction, ctx: Ctx, run: { id: string; idx: number }): Promise<ActionOutcome> {
    const today = this.clock.todayIst();
    const clientId = this.clientOf(ctx); const taskId = this.taskOf(ctx);
    switch (a.type) {
      case 'create_task': {
        const assignee = this.person(a.assignee, ctx, rule) ?? rule.owner_id;
        const r = await this.tasks.create(actor, { client_id: clientId, title: this.render(a.title, ctx), description: a.description ? this.render(a.description, ctx) : `Created by automation “${rule.name}”.`,
          assignee_id: assignee, priority: a.priority, act_by: a.dueInDays !== undefined ? addDaysIso(today, a.dueInDays) : null,
          checks: a.checklist.map((l) => { const label = this.render(l, ctx); return { key: checkKey(label), label, required: false, done: false }; }) });
        return { status: 'done', result: { taskId: r.id } };
      }
      case 'assign_task': {
        if (!taskId) return refused('no_task');
        const to = this.person(a.to, ctx, rule);
        if (!to) return refused('no_recipient');
        if (ctx.task?.assigneeId === to) return { status: 'skipped', code: 'no_change' };
        await this.tasks.update(actor, taskId, { assignee_id: to });
        return { status: 'done', result: { taskId, assigneeId: to } };
      }
      case 'add_checklist_item': {
        if (!taskId) return refused('no_task');
        const t = await this.tasks.get(actor, taskId);
        const label = this.render(a.label, ctx); const key = checkKey(label);
        const checks = (t.checks as Array<{ key: string }>) ?? [];
        if (checks.some((c) => c.key === key)) return { status: 'skipped', code: 'exists' };
        await this.tasks.update(actor, taskId, { checks: [...checks, { key, label, required: a.required, done: false }] });
        return { status: 'done', result: { taskId, key } };
      }
      case 'set_task_status': {
        if (!taskId) return refused('no_task');
        if (ctx.task?.status === a.status) return { status: 'skipped', code: 'no_change' };
        await this.tasks.update(actor, taskId, { status: a.status, ...(a.pendingIssue ? { pending_issue: this.render(a.pendingIssue, ctx) } : {}) });
        return { status: 'done', result: { taskId, status: a.status } };
      }
      case 'send_message': {
        if (!clientId) return refused('no_client');
        const vars = Object.fromEntries(Object.entries(a.vars ?? {}).map(([k, v]) => [k, this.render(v, ctx)]));
        const r = await this.comm.send(actor, { clientId, channel: a.channel, templateId: a.templateId ?? null, vars,
          subject: a.subject ? this.render(a.subject, ctx) : null, body: a.body ? this.render(a.body, ctx) : null });
        return { status: r.status === 'queued' ? 'queued' : r.status === 'failed' ? 'failed' : 'done', code: r.status === 'failed' ? 'send_failed' : null,
          result: { messageId: r.id, status: r.status, sendAt: r.sendAt }, costPaise: r.costPaise };
      }
      case 'create_pbc_request': {
        const eng = s((ctx.pbc as Record<string, unknown> | undefined)?.engagementId);
        if (!eng) return refused('no_engagement');
        const r = await this.work.addPbc(actor, eng, a.items.map((i) => ({ title: this.render(i.title, ctx), dueDate: i.dueInDays !== undefined ? addDaysIso(today, i.dueInDays) : null })));
        return { status: 'done', result: { pbcItemIds: r.ids } };
      }
      case 'notify': {
        const ids = [...new Set(a.to.map((p) => this.person(p, ctx, rule)).filter((x): x is string => !!x))];
        const module: Module = ctx.lead && !ctx.client ? 'leads' : 'clients';
        const r = await this.db.tenantTx(rule.tenant_id, async (tx) => {
          const users = await usersSeeing(tx, ids, clientId, module);
          if (!users.length) return null;
          return insertNotifications(tx, rule.tenant_id, { userIds: users, category: 'automation.alert', priority: a.priority, title: this.render(a.title, ctx), body: a.body ? this.render(a.body, ctx) : `From automation “${rule.name}”`,
            entityType: ctx.entity.type, entityId: ctx.entity.id, dedupeKey: `auto:${run.id}:${run.idx}` });
        });
        if (!r) return refused('no_recipient');
        if (r.cursor) this.realtime.publish({ type: 'changed', tenantId: rule.tenant_id, cursor: r.cursor });
        return { status: 'done', result: { notificationIds: r.ids, recipients: r.ids.length } };
      }
      case 'add_timeline_note': {
        if (!clientId) return refused('no_client');
        const r = await this.comm.logActivity(actor, clientId, { channel: 'note', subject: `Automation: ${rule.name}`.slice(0, 200), body: this.render(a.body, ctx) });
        return { status: 'done', result: { messageId: r.id } };
      }
      case 'create_invoice_draft': {
        if (!clientId) return refused('no_client');
        // Draft only — issuing always needs a person (D143).
        const r = await this.invoices.create(actor, { clientId, notes: `Drafted by automation “${rule.name}”.`, lines: [{ description: this.render(a.description, ctx), ratePaise: a.ratePaise,
          sac: a.sac ?? null, gstRate: a.gstRate ?? null, taskIds: a.linkTask && taskId ? [taskId] : [] }] });
        return { status: 'done', result: { invoiceId: r.id, draft: true } };
      }
      case 'request_esign': {
        const doc = ctx.document as Record<string, unknown> | undefined;
        if (!doc?.id || !clientId) return refused('no_document');
        const contact = await this.db.tenantTx(rule.tenant_id, async (tx) => (await tx.query(`SELECT id FROM contact WHERE client_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, name LIMIT 1`, [clientId])).rows[0]?.id as string | undefined);
        if (!contact) return refused('no_contact');
        const sug = await this.ai.proposeAction(actor, { kind: 'esign_request', clientId, entityType: 'document', entityId: String(doc.id), label: String(doc.name ?? ''), ruleId: rule.id, runId: run.id,
          payload: { title: this.render(a.title, ctx), mode: 'parallel', items: [{ documentId: doc.id, signers: [{ kind: 'contact', contactId: contact }] }] } });
        return { status: 'done', code: 'needs_approval', result: { suggestionId: sug.id } };
      }
      case 'ai_draft_message': {
        if (!clientId) return refused('no_client');
        const contextText = [ctx.task?.title, (ctx.notice as Record<string, unknown> | undefined)?.title, (ctx.invoice as Record<string, unknown> | undefined)?.number, (ctx.document as Record<string, unknown> | undefined)?.name]
          .filter(Boolean).map(String).join('\n') || `Event ${ctx.event.type}`;
        const sug = await this.ai.draftForAutomation(actor, { clientId, channel: a.channel, instruction: this.render(a.instruction, ctx), contextText, ruleId: rule.id, runId: run.id });
        return { status: 'done', code: 'needs_approval', result: { suggestionId: sug.id }, costPaise: Number((sug.meta as { costPaise?: number })?.costPaise ?? 0) };
      }
      case 'ai_classify_upload': {
        const doc = ctx.document as Record<string, unknown> | undefined;
        if (!doc?.id) return refused('no_document');
        const sug = await this.ai.classify(actor, String(doc.id), rule.id, run.id);
        return { status: 'done', code: 'needs_approval', result: { suggestionId: sug.id }, costPaise: Number((sug.meta as { costPaise?: number })?.costPaise ?? 0) };
      }
    }
  }

  /** Dry-run: what the action would do, in a READ ONLY transaction (no side effects), incl. consent/quiet-hours/cap/permission refusals and cost. */
  async plan(tx: Tx, actor: RequestActor, rule: RuleRow, a: AutomationAction, ctx: Ctx): Promise<ActionPlan> {
    const now = this.clock.now();
    const clientId = this.clientOf(ctx); const taskId = this.taskOf(ctx);
    const client = clientId ? (await tx.query('SELECT * FROM client WHERE id = $1', [clientId])).rows[0] : null;
    const cctx = client ? clientCtx(visibilityOf(client)) : undefined;
    const permOk = ACTION_PERMS[a.type].every(([m, act]) => (cctx ? can(actor, m as Module, act as Action, cctx) : actor.superAdmin || (effectiveScope(actor, m as Module, act as Action)?.scope ?? 'none') !== 'none'));
    const plan = (summary: string, wouldRefuse: string | null = null, details: Record<string, unknown> = {}, costPaise = 0): ActionPlan =>
      ({ type: a.type, summary, wouldRefuse: wouldRefuse ?? (permOk ? null : 'forbidden'), costPaise, details });
    switch (a.type) {
      case 'create_task': return plan(`Create task “${this.render(a.title, ctx)}”`, null, { assigneeId: this.person(a.assignee, ctx, rule), checklist: a.checklist.length });
      case 'assign_task': return plan('Reassign the task', taskId ? (this.person(a.to, ctx, rule) ? null : 'no_recipient') : 'no_task', { to: this.person(a.to, ctx, rule) });
      case 'add_checklist_item': {
        const label = this.render(a.label, ctx);
        const exists = ((ctx.task?.checks as Array<{ key: string }>) ?? []).some((c) => c.key === checkKey(label));
        return plan(`Add checklist item “${label}”`, taskId ? (exists ? 'exists' : null) : 'no_task');
      }
      case 'set_task_status': {
        if (!taskId) return plan(`Set status ${a.status}`, 'no_task');
        const udin = a.status === 'done' ? await udinGateError(tx, taskId) : null;
        return plan(`Set task status ${String(ctx.task?.status)} → ${a.status}`, udin ?? (ctx.task?.status === a.status ? 'no_change' : null));
      }
      case 'send_message': {
        if (!clientId) return plan('Send a message', 'no_client');
        const target = await addressFor(tx, clientId, a.channel);
        const address = normalizeAddress(a.channel, target.address);
        if (!address) return plan(`Send ${a.channel}`, 'no_address');
        let category: TemplateCategory = 'transactional'; let text = a.body ? this.render(a.body, ctx) : '';
        if (a.templateId) {
          const t = (await tx.query('SELECT * FROM comm_template WHERE id = $1 AND deleted_at IS NULL', [a.templateId])).rows[0];
          if (!t || t.channel !== a.channel) return plan(`Send ${a.channel}`, 'bad_template');
          if (t.status !== 'approved') return plan(`Send ${a.channel} template ${t.name}`, 'template_not_approved');
          category = t.category; text = t.body;
        } else if (a.channel === 'whatsapp') {
          const open = (await tx.query(`SELECT 1 FROM comm_message WHERE direction = 'in' AND channel = 'whatsapp' AND address = $1 AND occurred_at > $2::timestamptz - interval '24 hours'`, [address, now])).rowCount;
          if (!open) return plan('Send WhatsApp free text', 'template_required');
        }
        const chk = await checkSend(tx, await loadCommSettings(tx), await loadRates(tx), { channel: a.channel, address, category, text, now });
        const deferred = chk.sendAt > now;
        return plan(`Send ${a.channel} (${category}) to ${maskAddress(address)}${deferred ? ` at ${chk.sendAt.toISOString()} (quiet hours)` : ''}`, chk.error,
          { address: maskAddress(address), category, sendAt: chk.sendAt, quietHoursDeferred: deferred, capWarning: chk.capWarning }, chk.costPaise);
      }
      case 'create_pbc_request': return plan(`Request ${a.items.length} PBC item(s)`, (ctx.pbc as Record<string, unknown> | undefined)?.engagementId ? null : 'no_engagement');
      case 'notify': {
        const ids = [...new Set(a.to.map((p) => this.person(p, ctx, rule)).filter((x): x is string => !!x))];
        const users = await usersSeeing(tx, ids, clientId, ctx.lead && !ctx.client ? 'leads' : 'clients');
        return { type: a.type, summary: `Notify ${users.length} user(s): “${this.render(a.title, ctx)}”`, wouldRefuse: users.length ? null : 'no_recipient', costPaise: 0, details: { recipients: users } };
      }
      case 'add_timeline_note': return plan('Add a timeline note', clientId ? null : 'no_client');
      case 'create_invoice_draft': return plan(`Draft invoice ₹${(a.ratePaise / 100).toFixed(2)} (never issued automatically)`, clientId ? null : 'no_client', { ratePaise: a.ratePaise });
      case 'request_esign': return plan('Propose an e-sign request (needs approval)', (ctx.document as Record<string, unknown> | undefined)?.id ? null : 'no_document');
      case 'ai_draft_message': case 'ai_classify_upload': {
        const st = (await tx.query('SELECT settings FROM ai_settings LIMIT 1')).rows[0]?.settings;
        const g = aiGate(aiSettingsSchema.safeParse(st ?? {}).data ?? aiSettingsSchema.parse({}), 'automation_draft', envNoAi());
        const cost = await this.ai.estimatePaise(tx, 2000, 800);
        return plan(a.type === 'ai_draft_message' ? 'AI drafts a message for approval (never sent automatically)' : 'AI suggests a category/FY for approval', g === 'ok' ? null : g, {}, cost);
      }
    }
  }
}
