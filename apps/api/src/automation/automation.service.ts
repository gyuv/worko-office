import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ACTION_PERMS, agentTemplate, AGENT_TEMPLATES, automationSettingsSchema, effectiveScope, nextRunAt, ruleDefinitionSchema, scopeErrors,
  type Action, type Module, type RuleDefinition, type RuleScope,
} from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { istMonth, monthRange } from '../comm/common.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { AutomationEngine, loadAutomationSettings, type Rule } from './engine.js';

const ruleOut = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, description: r.description, ownerId: r.owner_id, scope: r.scope, enabled: r.enabled, status: r.status, pausedReason: r.paused_reason, pausedAt: r.paused_at,
  definition: r.definition, triggerEvent: r.trigger_event, version: r.rule_version, agentKey: r.agent_key, agentParams: r.agent_params, consecutiveFailures: r.consecutive_failures,
  nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, createdAt: r.created_at, updatedAt: r.updated_at,
});
const runOut = (r: Record<string, unknown>) => ({
  id: r.id, ruleId: r.rule_id, ruleName: r.rule_name, ruleVersion: r.rule_version, eventId: r.event_id, eventType: r.event_type ?? null, entityType: r.entity_type ?? null, entityId: r.entity_id ?? null,
  subjectKey: r.subject_key, step: r.step, status: r.status, skipReason: r.skip_reason, depth: r.depth, actionsTotal: r.actions_total, actionsDone: r.actions_done,
  costPaise: Number(r.cost_paise ?? 0), error: r.error, detail: r.detail, attempts: r.attempts, startedAt: r.started_at, finishedAt: r.finished_at,
});

type RuleIn = { name: string; description?: string | null; scope: RuleScope; definition?: unknown; enabled?: boolean };

/** Firm-wide rules need automation:edit (or settings:edit) at 'all' scope (D142). */
const firmManager = (a: RequestActor) => !!a.superAdmin || effectiveScope(a, 'automation', 'edit')?.scope === 'all' || effectiveScope(a, 'settings', 'edit')?.scope === 'all';
const firmViewer = (a: RequestActor) => !!a.superAdmin || effectiveScope(a, 'automation', 'view')?.scope === 'all' || firmManager(a);
/** Rules (alias `r`) the actor may see: firm viewers all; others firm-scope rules and their own (also the Phase 11 report scope). */
export function ruleVisibleSql(a: RequestActor, p: Params, r = 'r') {
  if (firmViewer(a)) return 'TRUE';
  return `(${r}.scope = 'firm' OR ${r}.owner_id = ${p.add(a.userId)}::uuid)`;
}

/** Rules, versions, agents, runs, dry-runs, settings and the cost meter (REST-only — D147). */
@Injectable()
export class AutomationService {
  constructor(private db: DbService, private audit: AuditService, private clock: Clock, private realtime: RealtimeService, private engine: AutomationEngine) {}

  private firmManager(a: RequestActor) { return firmManager(a); }
  private requireManage(a: RequestActor, r: { scope: string; owner_id: string }) {
    if (r.scope === 'firm' ? this.firmManager(a) : r.owner_id === a.userId && !!effectiveScope(a, 'automation', 'edit')) return;
    throw new ForbiddenException({ message: r.scope === 'firm' ? 'Needs firm-wide automation:edit' : 'Only the owner manages a personal rule', code: 'forbidden' });
  }
  /**
   * A non-owner who edits the definition, enables, resumes or retries a rule must personally hold every module×action its
   * actions need (D153) — nobody can launch work on the strength of someone else's permissions.
   */
  private requireActionPerms(a: RequestActor, def: RuleDefinition) {
    if (a.superAdmin) return;
    const missing = [...def.actions, ...(def.ladder?.escalate ?? [])].flatMap((x) => ACTION_PERMS[x.type]).filter(([m, act]) => (effectiveScope(a, m as Module, act as Action)?.scope ?? 'none') === 'none');
    if (missing.length) throw new ForbiddenException({ message: `Needs ${[...new Set(missing.map(([m, x]) => `${m}:${x}`))].join(', ')}`, code: 'missing_action_permission' });
  }
  private visibleSql(a: RequestActor, p: Params, r = 'r') { return ruleVisibleSql(a, p, r); }
  private async load(tx: Tx, a: RequestActor, id: string, lock = false) {
    const p = new Params([id]);
    const r = (await tx.query(`SELECT * FROM automation_rule r WHERE r.id = $1 AND r.deleted_at IS NULL AND ${this.visibleSql(a, p)}${lock ? ' FOR UPDATE' : ''}`, p.values)).rows[0];
    if (!r) throw new NotFoundException();
    return r as Rule & Record<string, unknown>;
  }
  private parse(def: unknown, scope: RuleScope): RuleDefinition {
    const p = ruleDefinitionSchema.safeParse(def);
    if (!p.success) throw new BadRequestException({ message: 'Invalid rule', code: 'invalid_rule', issues: p.error.issues });
    const se = scopeErrors(p.data, scope);
    if (se.length) throw new BadRequestException({ message: 'Not allowed in a personal rule', code: 'personal_rule_action', issues: se.map((m) => ({ message: m })) });
    return p.data;
  }
  private columns(d: RuleDefinition) {
    const trigger = d.trigger.kind === 'event' ? d.trigger.event : 'schedule';
    return { trigger_kind: d.trigger.kind, trigger_event: trigger, listen: [...new Set([trigger, ...(d.ladder?.stopOn ?? [])])],
      next: d.trigger.kind === 'schedule' ? nextRunAt(d.trigger.schedule, this.clock.now()) : null };
  }
  private publish(tenantId: string, cursor: unknown) { if (cursor) this.realtime.publish({ type: 'changed', tenantId, cursor: Number(cursor) }); }

  // ---------- Rules ----------
  list(a: RequestActor, q: { scope?: RuleScope; enabled?: boolean }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params(); const w = ['r.deleted_at IS NULL', this.visibleSql(a, p)];
      if (q.scope) w.push(`r.scope = ${p.add(q.scope)}`);
      if (q.enabled !== undefined) w.push(`r.enabled = ${p.add(q.enabled)}`);
      return { items: (await tx.query(`SELECT * FROM automation_rule r WHERE ${w.join(' AND ')} ORDER BY r.created_at`, p.values)).rows.map(ruleOut) };
    });
  }
  get(a: RequestActor, id: string) { return this.db.tenantTx(a.tenantId, async (tx) => ruleOut(await this.load(tx, a, id))); }

  async create(a: RequestActor, b: RuleIn, agent?: { key: string; params: unknown }) {
    if (b.scope === 'firm' ? !this.firmManager(a) : !effectiveScope(a, 'automation', 'create')) throw new ForbiddenException({ message: b.scope === 'firm' ? 'Needs firm-wide automation:edit' : 'Needs automation:create', code: 'forbidden' });
    const d = this.parse(b.definition, b.scope);
    const c = this.columns(d);
    const id = uuidv7(); const now = this.clock.now();
    const out = await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = (await tx.query(`INSERT INTO automation_rule (id, tenant_id, name, description, owner_id, scope, enabled, definition, trigger_kind, trigger_event, listen_events, agent_key, agent_params,
          next_run_at, created_by, created_at, updated_by, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$5,$15,$5,$16) RETURNING *`,
      [id, a.tenantId, b.name, b.description ?? null, a.userId, b.scope, !!b.enabled, JSON.stringify(d), c.trigger_kind, c.trigger_event, c.listen, agent?.key ?? null,
        agent ? JSON.stringify(agent.params) : null, c.next, now, a.deviceId])).rows[0];
      await tx.query(`INSERT INTO automation_rule_version (id, tenant_id, rule_id, rule_version, name, definition, changed_by, changed_at, note) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)`,
        [uuidv7(), a.tenantId, id, b.name, JSON.stringify(d), a.userId, now, agent ? `agent ${agent.key}` : 'created']);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'automation.rule_created', entity: 'automation_rule', entityId: id,
        diff: { name: b.name, scope: b.scope, enabled: !!b.enabled, trigger: c.trigger_event, actions: d.actions.map((x) => x.type), agent: agent?.key ?? null } });
      return r;
    });
    if (b.enabled) await this.engine.ensureTick(a.tenantId, now);
    this.publish(a.tenantId, out.sync_cursor);
    return ruleOut(out);
  }

  async update(a: RequestActor, id: string, b: { name?: string; description?: string | null; definition?: unknown; note?: string }) {
    const now = this.clock.now();
    const out = await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.load(tx, a, id, true);
      this.requireManage(a, r);
      const d = b.definition !== undefined ? this.parse(b.definition, r.scope) : null;
      // Changing what a rule does makes the editor its owner: it then runs with the editor's permissions, never the previous owner's (D153).
      if (d) this.requireActionPerms(a, d);
      const newOwner = d ? a.userId : r.owner_id;
      const c = d ? this.columns(d) : null;
      const ver = d ? r.rule_version + 1 : r.rule_version;
      const row = (await tx.query(`UPDATE automation_rule SET name = COALESCE($2, name), description = CASE WHEN $3 THEN $4 ELSE description END, definition = COALESCE($5, definition),
          trigger_kind = COALESCE($6, trigger_kind), trigger_event = COALESCE($7, trigger_event), listen_events = COALESCE($8, listen_events), next_run_at = CASE WHEN $5::jsonb IS NULL THEN next_run_at ELSE $9 END,
          rule_version = $10, version = version + 1, updated_by = $11, device_id = $12, owner_id = $13, consecutive_failures = CASE WHEN $5::jsonb IS NULL THEN consecutive_failures ELSE 0 END WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.description !== undefined, b.description ?? null, d ? JSON.stringify(d) : null, c?.trigger_kind ?? null, c?.trigger_event ?? null, c?.listen ?? null, c?.next ?? null, ver, a.userId, a.deviceId, newOwner])).rows[0];
      if (d) await tx.query(`INSERT INTO automation_rule_version (id, tenant_id, rule_id, rule_version, name, definition, changed_by, changed_at, note, owner_id, previous_owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [uuidv7(), a.tenantId, id, ver, row.name, JSON.stringify(d), a.userId, now, b.note ?? null, newOwner, r.owner_id !== newOwner ? r.owner_id : null]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'automation.rule_updated', entity: 'automation_rule', entityId: id,
        diff: { name: b.name, description: b.description !== undefined, version: ver, definitionChanged: !!d, actions: d?.actions.map((x) => x.type), ownerId: newOwner, previousOwnerId: r.owner_id !== newOwner ? r.owner_id : null } });
      return row;
    });
    this.publish(a.tenantId, out.sync_cursor);
    return ruleOut(out);
  }

  /** enable / disable / resume (from paused: failures reset) / delete (soft). */
  async setState(a: RequestActor, id: string, op: 'enable' | 'disable' | 'resume' | 'delete') {
    const now = this.clock.now();
    const out = await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.load(tx, a, id, true);
      this.requireManage(a, r);
      if ((op === 'enable' || op === 'resume') && r.owner_id !== a.userId) this.requireActionPerms(a, ruleDefinitionSchema.parse(r.definition));
      if (op === 'resume' && r.status !== 'paused') throw new ConflictException({ message: 'Rule is not paused', code: 'not_paused' });
      const sql = {
        enable: `enabled = true`, disable: `enabled = false`, delete: `deleted_at = $2::timestamptz, enabled = false`,
        resume: `status = 'active', paused_reason = NULL, paused_at = NULL, consecutive_failures = 0`,
      }[op];
      const row = (await tx.query(`UPDATE automation_rule SET ${sql}, updated_at = $2::timestamptz, version = version + 1, updated_by = $3 WHERE id = $1 RETURNING *`, [id, now, a.userId])).rows[0];
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `automation.rule_${op === 'delete' ? 'deleted' : op === 'resume' ? 'resumed' : op === 'enable' ? 'enabled' : 'disabled'}`,
        entity: 'automation_rule', entityId: id, diff: { scope: r.scope } });
      return row;
    });
    if (op === 'enable' || op === 'resume') await this.engine.ensureTick(a.tenantId, now);
    this.publish(a.tenantId, out.sync_cursor);
    return op === 'delete' ? undefined : ruleOut(out);
  }

  versions(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.load(tx, a, id);
      return { items: (await tx.query(`SELECT rule_version AS version, name, definition, changed_by AS "changedBy", changed_at AS "changedAt", note, owner_id AS "ownerId", previous_owner_id AS "previousOwnerId" FROM automation_rule_version WHERE rule_id = $1 ORDER BY rule_version DESC`, [id])).rows };
    });
  }

  // ---------- Dry-run ----------
  async dryRunRule(a: RequestActor, id: string, o: { limit: number; entityType?: string; entityId?: string; definition?: unknown }) {
    const r = await this.db.tenantTx(a.tenantId, (tx) => this.load(tx, a, id));
    // Trying a different definition against this rule's owner is an edit in disguise: manage rights required (D154).
    if (o.definition !== undefined) this.requireManage(a, r);
    const d = o.definition !== undefined ? this.parse(o.definition, r.scope) : ruleDefinitionSchema.parse(r.definition);
    return this.engine.dryRun(a.tenantId, { id: r.id, tenant_id: a.tenantId, name: r.name, owner_id: r.owner_id, scope: r.scope }, d, o, this.clock.now(), a);
  }
  /** Draft rule (not saved): evaluated as if the caller owned it. */
  async dryRunDraft(a: RequestActor, b: { scope: RuleScope; definition?: unknown; limit: number; entityType?: string; entityId?: string }) {
    if (b.scope === 'firm' ? !this.firmManager(a) : !effectiveScope(a, 'automation', 'create')) throw new ForbiddenException({ message: 'Not allowed', code: 'forbidden' });
    const d = this.parse(b.definition, b.scope);
    return this.engine.dryRun(a.tenantId, { id: '00000000-0000-0000-0000-000000000000', tenant_id: a.tenantId, name: 'Draft', owner_id: a.userId, scope: b.scope }, d, b, this.clock.now(), a);
  }

  // ---------- Agents ----------
  agents() {
    return { items: AGENT_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, defaults: t.params.parse({}), definition: t.build(t.params.parse({})) })) };
  }
  private agentDef(key: string, params: unknown) {
    const t = agentTemplate(key);
    if (!t) throw new NotFoundException();
    const p = t.params.safeParse(params ?? {});
    if (!p.success) throw new BadRequestException({ message: 'Invalid parameters', code: 'invalid_params', issues: p.error.issues });
    return { t, params: p.data as Record<string, unknown>, def: t.build(p.data) };
  }
  previewAgent(a: RequestActor, key: string, b: { params?: unknown; limit: number }) {
    const { def } = this.agentDef(key, b.params);
    return this.dryRunDraft(a, { scope: 'firm', definition: def, limit: b.limit });
  }
  /** "Turn on" = instantiate the template with sensible defaults as an enabled firm rule, plus a dry-run preview of today. */
  async enableAgent(a: RequestActor, key: string, b: { params?: unknown; name?: string; enabled?: boolean }) {
    const { t, params, def } = this.agentDef(key, b.params);
    const rule = await this.create(a, { name: b.name ?? t.name, description: t.description, scope: 'firm', definition: def, enabled: b.enabled ?? true }, { key, params });
    const preview = await this.dryRunRule(a, rule.id as string, { limit: 20 });
    return { rule, preview };
  }

  // ---------- Runs ----------
  runs(a: RequestActor, q: { ruleId?: string; status?: string; limit: number; before?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params(); const w = [this.visibleSql(a, p)];
      if (q.ruleId) w.push(`x.rule_id = ${p.add(q.ruleId)}::uuid`);
      if (q.status) w.push(`x.status = ${p.add(q.status)}`);
      if (q.before) w.push(`x.started_at < ${p.add(q.before)}::timestamptz`);
      const rows = (await tx.query(`SELECT x.*, r.name AS rule_name, e.type AS event_type, e.entity_type, e.entity_id FROM automation_run x JOIN automation_rule r ON r.id = x.rule_id
        LEFT JOIN automation_event e ON e.id = x.event_id WHERE ${w.join(' AND ')} ORDER BY x.started_at DESC, x.id DESC LIMIT ${p.add(q.limit)}`, p.values)).rows;
      return { items: rows.map(runOut) };
    });
  }
  getRun(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([id]);
      const r = (await tx.query(`SELECT x.*, r.name AS rule_name, e.type AS event_type, e.entity_type, e.entity_id FROM automation_run x JOIN automation_rule r ON r.id = x.rule_id
        LEFT JOIN automation_event e ON e.id = x.event_id WHERE x.id = $1 AND ${this.visibleSql(a, p)}`, p.values)).rows[0];
      if (!r) throw new NotFoundException();
      const actions = (await tx.query(`SELECT idx, type, status, code, result, cost_paise AS "costPaise", error, attempts, finished_at AS "finishedAt" FROM automation_run_action WHERE run_id = $1 ORDER BY idx`, [id])).rows
        .map((x) => ({ ...x, costPaise: Number(x.costPaise) }));
      return { ...runOut(r), actions };
    });
  }
  async retryRun(a: RequestActor, id: string, expectedAttempts?: number) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const run = (await tx.query('SELECT rule_id FROM automation_run WHERE id = $1', [id])).rows[0];
      if (!run) throw new NotFoundException();
      const r = await this.load(tx, a, run.rule_id);
      this.requireManage(a, r);
      if (r.owner_id !== a.userId) this.requireActionPerms(a, ruleDefinitionSchema.parse(r.definition));
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'automation.run_retried', entity: 'automation_run', entityId: id, diff: { ruleId: r.id } });
    });
    const res = await this.engine.retry(a.tenantId, id, this.clock.now(), expectedAttempts);
    return { ...res, run: await this.getRun(a, id) };
  }

  // ---------- Settings + cost meter ----------
  settings(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => loadAutomationSettings(tx)); }
  async putSettings(a: RequestActor, body: unknown) {
    if (!a.superAdmin && effectiveScope(a, 'settings', 'edit')?.scope !== 'all') throw new ForbiddenException('Needs firm-wide settings:edit');
    const p = automationSettingsSchema.safeParse(body);
    if (!p.success) throw new BadRequestException({ message: 'Invalid settings', issues: p.error.issues });
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO automation_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET settings = $2, updated_by = $3, updated_at = now()`,
        [a.tenantId, JSON.stringify(p.data), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'automation.settings_updated', entity: 'automation_settings', entityId: null, diff: p.data });
    });
    return p.data;
  }
  /** Month cost per rule: messages (comm cost at queue time) + AI tokens, against each rule's cap and the firm cap. */
  costs(a: RequestActor, month?: string) {
    const m = month ?? istMonth(this.clock.now());
    const [from, to] = monthRange(m);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await loadAutomationSettings(tx);
      const p = new Params([from, to]);
      const rows = (await tx.query(`SELECT r.id, r.name, r.definition->'limits'->>'monthlyCostCapPaise' AS cap,
          COALESCE(sum(ra.cost_paise) FILTER (WHERE ra.type = 'send_message'), 0)::bigint AS comm, COALESCE(sum(ra.cost_paise) FILTER (WHERE ra.type LIKE 'ai_%'), 0)::bigint AS ai,
          count(ra.id) FILTER (WHERE ra.status IN ('done','queued'))::int AS actions
        FROM automation_rule r LEFT JOIN automation_run x ON x.rule_id = r.id LEFT JOIN automation_run_action ra ON ra.run_id = x.id AND ra.finished_at >= $1 AND ra.finished_at < $2
        WHERE r.deleted_at IS NULL AND ${this.visibleSql(a, p)} GROUP BY r.id ORDER BY r.created_at`, p.values)).rows;
      const items = rows.map((r) => ({ ruleId: r.id, name: r.name, commPaise: Number(r.comm), aiPaise: Number(r.ai), totalPaise: Number(r.comm) + Number(r.ai), capPaise: Number(r.cap ?? 0), actions: r.actions }));
      return { month: m, totalPaise: items.reduce((n, i) => n + i.totalPaise, 0), capPaise: s.monthlyCostCapPaise, items };
    });
  }
}
