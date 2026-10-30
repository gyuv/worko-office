import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ACTION_PERMS, actionsForStep, effectiveScope, automationSettingsSchema, causationVerdict, childCausation, COSTED_ACTIONS, evaluateCondition, isScanEvent, ladderStep,
  nextRunAt, ruleDefinitionSchema, SCAN_WINDOW_DAYS, withinCap,
  type AutomationAction, type AutomationSettings, type Causation, type ConditionTrace, type EventContext, type LadderStep, type Role, type RuleDefinition,
} from '@worko/domain';
import { AiService } from '../ai/ai.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import { Clock } from '../common/clock.js';
import { istDay, istMonth, monthRange } from '../comm/common.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { ymd } from '../practice/common.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { ActionRunner, classifyError, type ActionOutcome, type ActionPlan, type RuleRow } from './actions.js';
import { withCausation } from './causation.js';
import { buildContext, candidateEvents, entityVisible, scanSelect, type EventRow } from './context.js';

export const EVENT_JOB = 'automation.event';
export const TICK_JOB = 'automation.tick';
const TICK_MINUTES = 15;
/** A claimed action / running run older than this is considered abandoned (crash) and may be re-taken. */
export const STALE_MS = 10 * 60_000;

export type Rule = RuleRow & { enabled: boolean; status: string; definition: unknown; trigger_event: string; trigger_kind: string; rule_version: number; consecutive_failures: number; next_run_at: Date | null };

export async function loadAutomationSettings(tx: Tx): Promise<AutomationSettings> {
  const s = (await tx.query('SELECT settings FROM automation_settings LIMIT 1')).rows[0]?.settings;
  const p = automationSettingsSchema.safeParse(s ?? {});
  return p.success ? p.data : automationSettingsSchema.parse({});
}

/** Owner's grants filtered to what the rule's actions need (D142) — a rule can never do more than its owner, nor more than it declares. */
export function intersectActor(full: RequestActor, def: RuleDefinition): RequestActor {
  const need = new Set<string>(['clients:view', 'leads:view']);
  for (const a of [...def.actions, ...(def.ladder?.escalate ?? [])]) for (const [m, act] of ACTION_PERMS[a.type]) { need.add(`${m}:${act}`); need.add(`${m}:view`); }
  const roles: Role[] = full.roles.map((r) => ({ ...r, grants: r.grants.filter((g) => need.has(`${g.module}:${g.action}`)) }));
  return { ...full, roles, superAdmin: false };
}

/**
 * The automation engine (M15): outbox events → rules (exactly once per rule × event via automation_run's idempotency key),
 * daily scans for time-based events, IST schedules, ladders per subject, loop prevention, rate limits, cost caps,
 * pause-on-failure, and read-only dry-runs. Actions go through ActionRunner → the owning services.
 */
@Injectable()
export class AutomationEngine implements OnModuleInit {
  private log = new Logger('Automation');
  constructor(private db: DbService, private audit: AuditService, private clock: Clock, private jobs: JobQueueService, private realtime: RealtimeService,
    private runner: ActionRunner, private ai: AiService) {}

  onModuleInit() {
    this.jobs.register(EVENT_JOB, async (j, at) => { await this.processEvent(j.tenant_id, j.ref_id, at); });
    this.jobs.register(TICK_JOB, async (j, at) => {
      await this.tick(j.tenant_id, at);
      throw new Reschedule(new Date(at.getTime() + TICK_MINUTES * 60_000));
    });
    if (Number(process.env.JOB_POLL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2000)) > 0) {
      void this.db.systemTx((tx) => tx.query(`INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) SELECT DISTINCT r.tenant_id, $1, r.tenant_id, now() FROM automation_rule r WHERE r.enabled AND r.deleted_at IS NULL
        ON CONFLICT (tenant_id, kind) WHERE kind = 'automation.tick' AND dead_at IS NULL DO NOTHING`, [TICK_JOB])).catch((e) => this.log.error(e));
    }
  }

  /** Ensures the tenant's tick job exists (after a rule is enabled). Owner connection: ON CONFLICT needs SELECT on job_queue. */
  ensureTick(tenantId: string, at: Date) {
    return this.db.systemTx((tx) => tx.query(`INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES ($1,$2,$1,$3) ON CONFLICT (tenant_id, kind) WHERE kind = 'automation.tick' AND dead_at IS NULL DO NOTHING`, [tenantId, TICK_JOB, at]));
  }

  // ---------- Tick: scans, schedules, retention ----------
  async tick(tenantId: string, at: Date) {
    const today = istDay(at);
    const out = await this.db.tenantTx(tenantId, async (tx) => {
      const listening = new Set((await tx.query(`SELECT DISTINCT unnest(listen_events) AS e FROM automation_rule WHERE enabled AND status = 'active' AND deleted_at IS NULL`)).rows.map((r) => r.e as string));
      // Every tick scans (cheap, index-backed); the per-day dedupe key makes repeats no-ops, and a rule enabled mid-day is picked up at once.
      let scanned = 0;
      {
        for (const type of [...listening].filter(isScanEvent)) {
          const r = await tx.query(`WITH s AS (${scanSelect(type)}), ins AS (
              INSERT INTO automation_event (id, tenant_id, type, entity_type, entity_id, client_id, payload, dedupe_key, occurred_at, device_id)
              SELECT gen_random_uuid(), $3, $4, s.et, s.id, s.client_id, jsonb_build_object('due', s.due, 'subjectKey', s.et || ':' || s.id || ':' || s.due), $4 || ':' || s.id || ':' || $1, $5, 'server' FROM s
              ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id)
            INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) SELECT $3, '${EVENT_JOB}', id, 'epoch' FROM ins`, [today, SCAN_WINDOW_DAYS, tenantId, type, at]);
          scanned += r.rowCount ?? 0;
        }
        await tx.query(`INSERT INTO automation_settings (tenant_id, last_scan_day) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET last_scan_day = $2`, [tenantId, today]);
      }
      // Schedules (IST): one event per due slot, then the next slot.
      let scheduled = 0;
      for (const r of (await tx.query(`SELECT id, definition, next_run_at FROM automation_rule WHERE trigger_kind = 'schedule' AND enabled AND status = 'active' AND deleted_at IS NULL AND next_run_at <= $1 FOR UPDATE`, [at])).rows) {
        const d = ruleDefinitionSchema.safeParse(r.definition);
        if (!d.success || d.data.trigger.kind !== 'schedule') continue;
        const id = uuidv7();
        const ins = await tx.query(`INSERT INTO automation_event (id, tenant_id, type, entity_type, entity_id, payload, dedupe_key, occurred_at, device_id) VALUES ($1,$2,'schedule','automation_rule',$3,$4,$5,$6,'server')
          ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`, [id, tenantId, r.id, JSON.stringify({ slot: r.next_run_at }), `schedule:${r.id}:${new Date(r.next_run_at).toISOString()}`, at]);
        if (ins.rowCount) { await this.jobs.enqueue(tx, tenantId, EVENT_JOB, id, new Date(0)); scheduled++; }
        await tx.query('UPDATE automation_rule SET next_run_at = $2 WHERE id = $1', [r.id, nextRunAt(d.data.trigger.schedule, at)]);
      }
      // Outbox retention.
      const s = await loadAutomationSettings(tx);
      await tx.query(`DELETE FROM automation_event e WHERE processed_at < $1::timestamptz - make_interval(days => $2) AND NOT EXISTS (SELECT 1 FROM automation_run r WHERE r.event_id = e.id)`, [at, s.eventRetentionDays]);
      return { scanned, scheduled };
    });
    const purged = await this.ai.purgeExpired(tenantId, at);
    const reaped = await this.reapStale(tenantId, at);
    return { ...out, purged, reaped };
  }

  // ---------- Events ----------
  async processEvent(tenantId: string, eventId: string, at: Date) {
    const { ev, rules } = await this.db.tenantTx(tenantId, async (tx) => {
      const ev = (await tx.query('SELECT * FROM automation_event WHERE id = $1', [eventId])).rows[0] as EventRow | undefined;
      if (!ev) return { ev: null, rules: [] as Rule[] };
      const rules = (await tx.query(`SELECT * FROM automation_rule WHERE enabled AND status = 'active' AND deleted_at IS NULL AND $1 = ANY (listen_events) AND ($1 <> 'schedule' OR id = $2) ORDER BY created_at, id`,
        [ev.type, ev.entity_id])).rows as Rule[];
      return { ev, rules };
    });
    if (!ev) return;
    for (const r of rules) {
      try {
        const def = ruleDefinitionSchema.safeParse(r.definition);
        if (!def.success) continue;
        if (def.data.ladder?.stopOn.includes(ev.type as never) && r.trigger_event !== ev.type) await this.stopSubjects(tenantId, r, ev, at);
        else if (r.trigger_event === ev.type) await this.runRule(tenantId, r, def.data, ev, at);
      } catch (e) { this.log.error(`Rule ${r.id} on event ${ev.id}: ${(e as Error).message}`); }
    }
    await this.db.tenantTx(tenantId, (tx) => tx.query('UPDATE automation_event SET processed_at = $2 WHERE id = $1', [eventId, at]));
  }

  /** A ladder's stop event (e.g. the client uploaded): stops every open subject of that rule for the client, recorded as a run. */
  private async stopSubjects(tenantId: string, r: Rule, ev: EventRow, at: Date) {
    if (!ev.client_id) return;
    await this.db.tenantTx(tenantId, async (tx) => {
      const n = (await tx.query(`UPDATE automation_subject SET stopped_at = $3, stop_reason = $4, version = version + 1 WHERE rule_id = $1 AND client_id = $2 AND stopped_at IS NULL`,
        [r.id, ev.client_id, at, ev.type])).rowCount ?? 0;
      if (!n) return;
      await tx.query(`INSERT INTO automation_run (id, tenant_id, rule_id, rule_version, event_id, step, status, skip_reason, idempotency_key, started_at, finished_at, device_id)
        VALUES ($1,$2,$3,$4,$5,'stop','succeeded',$6,$7,$8,$8,'server') ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [uuidv7(), tenantId, r.id, r.rule_version, ev.id, `stopped ${n} on ${ev.type}`, `${r.id}:${ev.id}`, at]);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: `automation:${r.id}`, action: 'automation.ladder_stopped', entity: 'automation_rule', entityId: r.id, diff: { event: ev.type, eventId: ev.id, subjects: n } });
    });
  }

  async actorFor(tx: Tx, r: RuleRow): Promise<RequestActor | null> {
    const u = (await tx.query(`SELECT id, branch_id FROM app_user WHERE id = $1 AND status = 'active' AND deleted_at IS NULL AND kind = 'staff'`, [r.owner_id])).rows[0];
    if (!u) return null;
    return { userId: u.id, tenantId: r.tenant_id, sessionId: '', deviceId: `automation:${r.id}`, branchId: u.branch_id ?? null, teamIds: await loadTeamIds(tx, u.id), roles: await loadUserRoles(tx, u.id) };
  }

  private async monthCost(tx: Tx, ruleId: string | null, at: Date) {
    const [from, to] = monthRange(istMonth(at));
    return Number((await tx.query(`SELECT COALESCE(sum(ra.cost_paise), 0)::bigint AS n FROM automation_run_action ra JOIN automation_run r ON r.id = ra.run_id
      WHERE ra.finished_at >= $1 AND ra.finished_at < $2 AND ($3::uuid IS NULL OR r.rule_id = $3)`, [from, to, ruleId])).rows[0].n);
  }
  /** Claimed (running/retrying) actions count too, so concurrent runs can't all squeeze under the limit. */
  private async actionsToday(tx: Tx, ruleId: string | null, at: Date) {
    const day = istDay(at); const from = new Date(`${day}T00:00:00+05:30`);
    return Number((await tx.query(`SELECT count(*)::int AS n FROM automation_run_action ra JOIN automation_run r ON r.id = ra.run_id
      WHERE ra.finished_at >= $1 AND ra.status IN ('done','queued','running','retrying') AND ($2::uuid IS NULL OR r.rule_id = $2)`, [from, ruleId])).rows[0].n);
  }

  /**
   * Gates shared by first runs, crash resumes and retries (D158): rule live, firm switch, loop verdict, entity present,
   * owner active, owner sees the subject (client, task scope, lead scope), conditions (re-)evaluated.
   */
  private async gates(tenantId: string, r: Rule, def: RuleDefinition, ev: EventRow, step: LadderStep, at: Date, steps: number) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const live = (await tx.query(`SELECT 1 FROM automation_rule WHERE id = $1 AND enabled AND status = 'active' AND deleted_at IS NULL`, [r.id])).rowCount;
      const settings = await loadAutomationSettings(tx);
      const base = { settings, ctx: null as EventContext | null, full: null as RequestActor | null, trace: [] as ConditionTrace[] };
      if (!live) return { ...base, skip: 'rule_inactive' };
      if (!settings.enabled) return { ...base, skip: 'automation_off' };
      const verdict = causationVerdict(ev.causation as Causation | null, r.id);
      if (verdict !== 'ok') return { ...base, skip: verdict };
      const c0 = await buildContext(tx, ev, istDay(at));
      if (!c0) return { ...base, skip: 'entity_gone' };
      const full = await this.actorFor(tx, r);
      if (!full) return { ...base, fail: 'owner_inactive' };
      const ctx = { ...c0, ladder: { step, steps } } as EventContext;
      if (!(await entityVisible(tx, full, ctx))) return { ...base, skip: 'outside_owner_scope' };
      const trace: ConditionTrace[] = [];
      if (!evaluateCondition(def.conditions, ctx, trace)) return { ...base, ctx, full, trace, noMatch: true };
      return { ...base, ctx, full, trace };
    });
  }

  /** One rule × one event. Returns the run id (null when nothing was due or it already ran). A stale `running` run is resumed. */
  async runRule(tenantId: string, r: Rule, def: RuleDefinition, ev: EventRow, at: Date): Promise<string | null> {
    const today = istDay(at);
    const scan = isScanEvent(ev.type);
    const subjectKey = scan ? String(ev.payload?.subjectKey ?? `${ev.entity_type}:${ev.entity_id}`) : null;
    const prep = await this.db.tenantTx(tenantId, async (tx) => {
      const sub = subjectKey ? (await tx.query('SELECT * FROM automation_subject WHERE rule_id = $1 AND subject_key = $2', [r.id, subjectKey])).rows[0] : null;
      const existing = (await tx.query('SELECT * FROM automation_run WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, `${r.id}:${ev.id}`])).rows[0];
      if (existing) {
        // Crash recovery (D159): only a run left `running` past the lease is resumed; actions already committed are not repeated.
        if (existing.status !== 'running' || new Date(existing.started_at).getTime() > at.getTime() - STALE_MS) return null;
        await tx.query('UPDATE automation_run SET attempts = attempts + 1, started_at = $2, version = version + 1 WHERE id = $1', [existing.id, at]);
        return { runId: existing.id as string, step: existing.step as LadderStep, sub };
      }
      const step: LadderStep = scan ? ladderStep(sub ? { steps: sub.steps, lastStepDay: ymd(sub.last_step_day), stoppedAt: sub.stopped_at, escalated: sub.escalated } : null, def.ladder, today) : 'first';
      if (step === 'wait' || step === 'done') return null;
      const runId = uuidv7();
      const ins = await tx.query(`INSERT INTO automation_run (id, tenant_id, rule_id, rule_version, event_id, subject_key, step, status, idempotency_key, depth, causation, started_at, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11,'server') ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
      [runId, tenantId, r.id, r.rule_version, ev.id, subjectKey, step, `${r.id}:${ev.id}`, (ev.causation as Causation | null)?.depth ?? 0, ev.causation ? JSON.stringify(ev.causation) : null, at]);
      if (!ins.rowCount) return null;
      return { runId, step, sub };
    });
    if (!prep) return null;
    const { runId, step } = prep;
    const finish = (status: string, extra: { skip?: string | null; error?: string | null; detail?: unknown; total?: number; done?: number; cost?: number } = {}) =>
      this.db.tenantTx(tenantId, async (tx) => {
        await tx.query(`UPDATE automation_run SET status = $2, skip_reason = $3, error = $4, detail = COALESCE($5, detail), actions_total = $6, actions_done = $7, cost_paise = $8, finished_at = $9, version = version + 1 WHERE id = $1`,
          [runId, status, extra.skip ?? null, extra.error ?? null, extra.detail ? JSON.stringify(extra.detail) : null, extra.total ?? 0, extra.done ?? 0, extra.cost ?? 0, at]);
        await tx.query('UPDATE automation_rule SET last_run_at = $2 WHERE id = $1', [r.id, at]);
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: `automation:${r.id}`, action: 'automation.run', entity: 'automation_run', entityId: runId,
          diff: { ruleId: r.id, event: ev.type, eventId: ev.id, status, step, skip: extra.skip ?? null, actions: extra.total ?? 0, done: extra.done ?? 0, costPaise: extra.cost ?? 0 } });
      });

    const g = await this.gates(tenantId, r, def, ev, step, at, prep.sub?.steps ?? 0);
    if ('skip' in g && g.skip) { await finish('skipped', { skip: g.skip }); return runId; }
    if ('fail' in g && g.fail) { await finish('failed', { error: g.fail }); await this.countFailure(tenantId, r, def, at, g.fail); return runId; }
    if ('noMatch' in g && g.noMatch) {
      if (prep.sub && !prep.sub.stopped_at) {
        await this.db.tenantTx(tenantId, (tx) => tx.query(`UPDATE automation_subject SET stopped_at = $2, stop_reason = 'conditions_no_longer_met', version = version + 1 WHERE id = $1`, [prep.sub.id, at]));
      }
      await finish('no_match', { detail: { conditions: g.trace.map(({ field, op, ok }) => ({ field, op, ok })) } });
      return runId;
    }
    const ctx = g.ctx!;
    const actions = actionsForStep(def, step);
    const actor = intersectActor(g.full!, def);
    const cause = childCausation(ev.causation as Causation | null, r.id, runId);
    for (let idx = 0; idx < actions.length; idx++) {
      await this.runAction(tenantId, r, def, g.settings, actor, ctx, cause, runId, idx, actions[idx]!, at, 'fresh');
    }
    // Subject state (ladders and once-per-subject) — applied once even if the run is resumed.
    if (subjectKey) {
      await this.db.tenantTx(tenantId, async (tx) => {
        if (!(await tx.query('UPDATE automation_run SET subject_done = true WHERE id = $1 AND NOT subject_done RETURNING id', [runId])).rowCount) return;
        await tx.query(`INSERT INTO automation_subject (id, tenant_id, rule_id, subject_key, entity_type, entity_id, client_id, steps, last_step_day, escalated, device_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'server')
          ON CONFLICT (rule_id, subject_key) DO UPDATE SET steps = automation_subject.steps + $8, last_step_day = $9, escalated = automation_subject.escalated OR $10, version = automation_subject.version + 1`,
        [uuidv7(), tenantId, r.id, subjectKey, ev.entity_type, ev.entity_id, ev.client_id, step === 'escalate' ? 0 : 1, today, step === 'escalate']);
      });
    }
    await this.settle(tenantId, r, def, runId, at, finish);
    return runId;
  }

  /** Recomputes the run's status from its action rows; failures count toward pausing. */
  private async settle(tenantId: string, r: Rule, def: RuleDefinition, runId: string, at: Date, finish?: (status: string, extra: { total?: number; done?: number; cost?: number; error?: string | null }) => Promise<void>) {
    const rows = await this.db.tenantTx(tenantId, async (tx) => (await tx.query('SELECT status, code, cost_paise FROM automation_run_action WHERE run_id = $1', [runId])).rows);
    const done = rows.filter((x) => x.status === 'done' || x.status === 'queued').length;
    const failed = rows.filter((x) => x.status === 'failed').length;
    const bad = rows.filter((x) => ['failed', 'refused', 'rate_limited'].includes(x.status)).length;
    const status = !bad ? 'succeeded' : failed === rows.length ? 'failed' : 'partial';
    const cost = rows.reduce((n, x) => n + Number(x.cost_paise), 0);
    const error = rows.find((x) => x.status === 'failed')?.code ?? null;
    if (finish) await finish(status, { total: rows.length, done, cost, error });
    else await this.db.tenantTx(tenantId, (tx) => tx.query(`UPDATE automation_run SET status = $2, actions_done = $3, cost_paise = $4, error = $5, finished_at = $6, version = version + 1 WHERE id = $1`, [runId, status, done, cost, error, at]));
    if (failed) await this.countFailure(tenantId, r, def, at, error ?? 'error');
    else if (done) await this.db.tenantTx(tenantId, (tx) => tx.query('UPDATE automation_rule SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0', [r.id]));
  }

  /**
   * Claims the action row FIRST (atomically, under a per-tenant×day advisory lock that also serialises the rate limits and
   * the cost caps with a reserved estimate), then calls the service with idempotency key `auto:<runId>:<idx>`, then records
   * the outcome. `fresh`: insert (or re-take a stale `running` claim); `retry`: only a `failed` row becomes `retrying` (D158).
   */
  private async runAction(tenantId: string, r: Rule, def: RuleDefinition, s: AutomationSettings, actor: RequestActor, ctx: EventContext, cause: Causation, runId: string, idx: number,
    a: AutomationAction, at: Date, mode: 'fresh' | 'retry'): Promise<ActionOutcome | null> {
    if (idx >= def.limits.maxActionsPerRun) {
      if (mode === 'fresh') await this.recordAction(tenantId, runId, idx, a.type, { status: 'skipped', code: 'rate_limited', error: 'maxActionsPerRun' }, at, true);
      return null;
    }
    const est = COSTED_ACTIONS.includes(a.type) ? (await this.db.readOnlyTx(tenantId, (tx) => this.runner.plan(tx, actor, r, a, ctx as never))).costPaise : 0;
    const claim = await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auto-day:${tenantId}:${istDay(at)}`]);
      const stale = new Date(at.getTime() - STALE_MS);
      const took = mode === 'retry'
        ? await tx.query(`UPDATE automation_run_action SET status = 'retrying', attempts = attempts + 1, finished_at = $3, version = version + 1 WHERE run_id = $1 AND idx = $2 AND status = 'failed' RETURNING id`, [runId, idx, at])
        : await tx.query(`INSERT INTO automation_run_action (id, tenant_id, run_id, idx, type, status, finished_at, device_id) VALUES ($1,$2,$3,$4,$5,'running',$6,'server')
            ON CONFLICT (run_id, idx) DO UPDATE SET status = 'running', attempts = automation_run_action.attempts + 1, finished_at = $6, version = automation_run_action.version + 1
            WHERE automation_run_action.status = 'running' AND automation_run_action.finished_at < $7 RETURNING id`, [uuidv7(), tenantId, runId, idx, a.type, at, stale]);
      if (!took.rowCount) return { taken: false as const };
      const limit = (await this.actionsToday(tx, r.id, at)) > def.limits.maxActionsPerDay ? 'maxActionsPerDay' : (await this.actionsToday(tx, null, at)) > s.maxActionsPerDay ? 'firm maxActionsPerDay' : null;
      if (limit) return { taken: true as const, pre: { status: 'skipped', code: 'rate_limited', error: limit } as ActionOutcome };
      if (est > 0 && (!withinCap(await this.monthCost(tx, r.id, at), est, def.limits.monthlyCostCapPaise) || !withinCap(await this.monthCost(tx, null, at), est, s.monthlyCostCapPaise))) {
        return { taken: true as const, pre: { status: 'refused', code: 'cost_cap', error: 'Monthly automation budget reached' } as ActionOutcome };
      }
      // Reserve the estimate so concurrent actions see it in the month's spend.
      await tx.query('UPDATE automation_run_action SET cost_paise = $3 WHERE run_id = $1 AND idx = $2', [runId, idx, est]);
      return { taken: true as const, pre: null };
    });
    if (!claim.taken) return null;
    let o: ActionOutcome;
    if (claim.pre) o = claim.pre;
    else { try { o = await withCausation(cause, () => this.runner.execute(actor, r, a, ctx as never, { id: runId, idx })); } catch (e) { o = classifyError(e); } }
    await this.recordAction(tenantId, runId, idx, a.type, o, at, false);
    return o;
  }

  private recordAction(tenantId: string, runId: string, idx: number, type: string, o: ActionOutcome, at: Date, insert: boolean) {
    const status = o.code === 'rate_limited' ? 'rate_limited' : o.status;
    const vals = [runId, idx, status, o.code ?? null, JSON.stringify(o.result ?? {}), o.costPaise ?? 0, o.error ?? null, at];
    return this.db.tenantTx(tenantId, (tx) => insert
      ? tx.query(`INSERT INTO automation_run_action (id, tenant_id, run_id, idx, type, status, code, result, cost_paise, error, finished_at, device_id) VALUES ($9,$10,$1,$2,$11,$3,$4,$5,$6,$7,$8,'server') ON CONFLICT (run_id, idx) DO NOTHING`,
        [...vals, uuidv7(), tenantId, type])
      : tx.query(`UPDATE automation_run_action SET status = $3, code = $4, result = $5, cost_paise = $6, error = $7, finished_at = $8, version = version + 1 WHERE run_id = $1 AND idx = $2`, vals));
  }

  /** Consecutive failing runs ≥ pauseAfterFailures → the rule pauses and its owner is told (automation.failed). */
  private async countFailure(tenantId: string, r: Rule, def: RuleDefinition, at: Date, code: string) {
    const cur = await this.db.tenantTx(tenantId, async (tx) => {
      const n = Number((await tx.query('UPDATE automation_rule SET consecutive_failures = consecutive_failures + 1 WHERE id = $1 RETURNING consecutive_failures', [r.id])).rows[0].consecutive_failures);
      if (n < def.limits.pauseAfterFailures) return 0;
      const c = (await tx.query(`UPDATE automation_rule SET status = 'paused', paused_reason = 'repeated_failures', paused_at = $2, version = version + 1 WHERE id = $1 AND status = 'active' RETURNING sync_cursor`, [r.id, at])).rows[0];
      if (!c) return 0;
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: `automation:${r.id}`, action: 'automation.rule_paused', entity: 'automation_rule', entityId: r.id, diff: { reason: 'repeated_failures', failures: n, lastError: code } });
      const notified = await insertNotifications(tx, tenantId, { userIds: [r.owner_id], category: 'automation.failed', priority: 'high', title: `Automation paused: ${r.name}`.slice(0, 200),
        body: `Paused after ${n} failing runs (last: ${code}). Fix it and resume.`, entityType: 'automation_rule', entityId: r.id, dedupeKey: `auto-paused:${r.id}:${at.toISOString()}` });
      return Math.max(Number(c.sync_cursor), notified.cursor);
    });
    if (cur) this.realtime.publish({ type: 'changed', tenantId, cursor: cur });
  }

  /** Re-runs a run's failed actions through the same gates, limits, caps and per-action claims as a first run. */
  /**
   * `expectedAttempts` = the run's `attempts` the caller saw (generation token). The bump is a compare-and-set, so two
   * retries sent with the same token run once; a stale token answers `already_retried`. Omitted → the current value.
   */
  async retry(tenantId: string, runId: string, at: Date, expectedAttempts?: number): Promise<{ retried: number; skipped?: string }> {
    const prep = await this.db.tenantTx(tenantId, async (tx) => {
      const run = (await tx.query('SELECT * FROM automation_run WHERE id = $1', [runId])).rows[0];
      const r = run && (await tx.query('SELECT * FROM automation_rule WHERE id = $1', [run.rule_id])).rows[0] as Rule;
      const ev = run?.event_id && (await tx.query('SELECT * FROM automation_event WHERE id = $1', [run.event_id])).rows[0] as EventRow;
      if (!run || !r || !ev) return null;
      const failed = (await tx.query(`SELECT idx FROM automation_run_action WHERE run_id = $1 AND status = 'failed' ORDER BY idx`, [runId])).rows.map((x) => Number(x.idx));
      const bumped = await tx.query('UPDATE automation_run SET attempts = attempts + 1 WHERE id = $1 AND attempts = $2 RETURNING attempts', [runId, expectedAttempts ?? Number(run.attempts)]);
      if (!bumped.rowCount) return 'stale' as const;
      return { run, r, ev, failed };
    });
    if (!prep) return { retried: 0, skipped: 'not_found' };
    if (prep === 'stale') return { retried: 0, skipped: 'already_retried' };
    const def = ruleDefinitionSchema.parse(prep.r.definition);
    const g = await this.gates(tenantId, prep.r, def, prep.ev, prep.run.step as LadderStep, at, 0);
    const why = ('skip' in g && g.skip) || ('fail' in g && g.fail) || ('noMatch' in g && g.noMatch && 'conditions_no_longer_met');
    if (why) return { retried: 0, skipped: String(why) };
    const actions = actionsForStep(def, prep.run.step as LadderStep);
    const actor = intersectActor(g.full!, def);
    const cause = childCausation(prep.ev.causation as Causation | null, prep.r.id, runId);
    let retried = 0;
    for (const idx of prep.failed) {
      const a = actions[idx]; if (!a) continue;
      if (await this.runAction(tenantId, prep.r, def, g.settings, actor, g.ctx!, cause, runId, idx, a, at, 'retry')) retried++;
    }
    if (retried) await this.settle(tenantId, prep.r, def, runId, at);
    return { retried };
  }

  /** Reaper (in the tick): runs still `running` past the lease get their event re-queued; runRule resumes them idempotently. */
  async reapStale(tenantId: string, at: Date) {
    return (await this.db.systemTx((tx) => tx.query(`INSERT INTO job_queue (tenant_id, kind, ref_id, run_at)
      SELECT r.tenant_id, $3, r.event_id, 'epoch' FROM automation_run r WHERE r.tenant_id = $1 AND r.status = 'running' AND r.event_id IS NOT NULL AND r.started_at < $2
        AND NOT EXISTS (SELECT 1 FROM job_queue j WHERE j.kind = $3 AND j.ref_id = r.event_id AND j.dead_at IS NULL)`, [tenantId, new Date(at.getTime() - STALE_MS), EVENT_JOB]))).rowCount ?? 0;
  }

  // ---------- Dry-run (no side effects: READ ONLY transaction) ----------
  /**
   * Evaluated as the INTERSECTION of the rule owner and the caller (D154): an item appears only if both can see its subject,
   * plans use the owner's rule-scoped grants further limited to what the caller holds, and items the caller can't see — or
   * that are skipped — contribute counts only (no ids, names or condition values).
   */
  async dryRun(tenantId: string, rule: RuleRow & { id: string }, def: RuleDefinition, o: { limit: number; entityType?: string; entityId?: string }, at: Date, caller: RequestActor) {
    const today = istDay(at);
    const ev = def.trigger.kind === 'event' ? def.trigger.event : 'schedule';
    return this.db.readOnlyTx(tenantId, async (tx) => {
      const settings = await loadAutomationSettings(tx);
      const full = await this.actorFor(tx, rule);
      const actor = full ? withinCaller(intersectActor(full, def), caller) : null;
      const cands = await candidateEvents(tx, ev, today, { ...o, ruleId: rule.id });
      const items: Array<Record<string, unknown>> = [];
      let matched = 0; let actionsCount = 0; let costPaise = 0; let hidden = 0; const refusals: Record<string, number> = {}; const skipped: Record<string, number> = {};
      for (const c of cands) {
        const c0 = await buildContext(tx, c, today);
        if (!c0) continue;
        if (!(await entityVisible(tx, caller, c0))) { hidden++; continue; }
        const subjectKey = isScanEvent(ev) ? String(c.payload?.subjectKey ?? '') : null;
        const sub = subjectKey && rule.id ? (await tx.query('SELECT * FROM automation_subject WHERE rule_id = $1 AND subject_key = $2', [rule.id, subjectKey])).rows[0] : null;
        const step: LadderStep = isScanEvent(ev) ? ladderStep(sub ? { steps: sub.steps, lastStepDay: ymd(sub.last_step_day), stoppedAt: sub.stopped_at, escalated: sub.escalated } : null, def.ladder, today) : 'first';
        const ctx = { ...c0, ladder: { step, steps: sub?.steps ?? 0 } } as EventContext;
        const skip = !settings.enabled ? 'automation_off' : !full ? 'owner_inactive' : !(await entityVisible(tx, full, ctx)) ? 'outside_owner_scope'
          : step === 'wait' || step === 'done' ? `ladder_${step}` : null;
        if (skip) { skipped[skip] = (skipped[skip] ?? 0) + 1; continue; }
        const trace: ConditionTrace[] = [];
        const ok = evaluateCondition(def.conditions, ctx, trace);
        const plans: ActionPlan[] = [];
        if (ok && actor) {
          matched++;
          for (const a of actionsForStep(def, step).slice(0, def.limits.maxActionsPerRun)) {
            const p = await this.runner.plan(tx, actor, rule, a, ctx as never);
            plans.push(p); actionsCount++;
            if (p.wouldRefuse) refusals[p.wouldRefuse] = (refusals[p.wouldRefuse] ?? 0) + 1; else costPaise += p.costPaise;
          }
        }
        items.push({ entity: ctx.entity, clientId: (ctx.client as { id?: string } | undefined)?.id ?? null, clientName: (ctx.client as { name?: string } | undefined)?.name ?? null,
          step, matched: ok, conditions: trace.map(({ field, op, ok: k, actual }) => ({ field, op, ok: k, actual })), actions: plans });
      }
      return { trigger: ev, asOf: today, evaluated: items.length, hidden, skipped, matched, actions: actionsCount, estimatedCostPaise: costPaise, refusals,
        monthToDateCostPaise: rule.id ? await this.monthCost(tx, rule.id, at) : 0, capPaise: def.limits.monthlyCostCapPaise, items };
    });
  }
}

/** Owner's (rule-scoped) grants limited to module×actions the caller also holds, at the narrower of the two scopes. */
export function withinCaller(owner: RequestActor, caller: RequestActor): RequestActor {
  if (caller.superAdmin) return owner;
  const rank: Record<string, number> = { none: 0, own: 1, team: 2, groups: 3, branch: 4, all: 5 };
  const roles = owner.roles.map((r) => ({ ...r, grants: r.grants.flatMap((g) => {
    const c = effectiveScope(caller, g.module, g.action);
    if (!c || c.scope === 'none') return [];
    return [rank[c.scope]! < rank[g.scope]! ? { ...g, scope: c.scope, clientGroupIds: c.clientGroupIds } : g];
  }) }));
  return { ...owner, roles };
}
