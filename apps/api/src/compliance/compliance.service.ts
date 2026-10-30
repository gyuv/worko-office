import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { computeLateFee, dates, diffSchedules, loadPack, matches, periodsForFy, ruleInForce, schedule, type Extension, type LateFeeInput, type RulePack } from '@worko/rules';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params } from '../clients/scope.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { RulesService } from '../rules/rules.service.js';
import { SyncService } from '../sync/sync.service.js';
import { requireFirmWide, systemActor } from '../tasks/system-actor.js';
import { ymd } from '../tasks/scope.js';
import { approvedExtensions, fyOfDate, fyOfPeriodKey, loadClientsWithFacts, todayIst } from './facts.js';
import { RulePackService } from './rule-pack.service.js';

const dayNo = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
const presentPack = (r: Record<string, unknown>) => ({
  id: r.id, packId: r.pack_id, version: r.pack_version, status: r.status, notes: r.notes, ruleCount: ((r.pack as RulePack)?.rules ?? []).length,
  uploadedBy: r.uploaded_by, approvedBy: r.approved_by, approvedAt: r.approved_at, createdAt: r.created_at,
});
const presentExt = (r: Record<string, unknown>) => ({
  id: r.id, ruleId: r.rule_id, periodKey: r.period_key, newDueDate: ymd(r.new_due_date), scope: r.scope, notification: r.notification, status: r.status,
  createdBy: r.created_by, createdAt: r.created_at, approvedBy: r.approved_by, approvedAt: r.approved_at, tasksMoved: r.tasks_moved,
});

@Injectable()
export class ComplianceService {
  constructor(private db: DbService, private packs: RulePackService, private rules: RulesService, private audit: AuditService, private sync: SyncService, private realtime: RealtimeService) {}

  // ---------- Rule packs ----------
  listPacks(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.packs.active(tx, a.tenantId);
      return (await tx.query('SELECT * FROM rule_pack ORDER BY created_at DESC')).rows.map(presentPack);
    });
  }

  async uploadPack(a: RequestActor, json: unknown) {
    let pack: RulePack;
    try { pack = loadPack(json); } catch (e) { throw new BadRequestException({ message: 'Invalid rule pack', issues: (e as { issues?: unknown[] }).issues ?? [{ message: (e as Error).message }] }); }
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      try {
        await tx.query(`INSERT INTO rule_pack (id, tenant_id, pack_id, pack_version, status, pack, notes, uploaded_by) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7)`,
          [id, a.tenantId, pack.id, pack.version, JSON.stringify(pack), pack.notes ?? null, a.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('That pack version exists');
        throw e;
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'rule_pack.uploaded', entity: 'rule_pack', entityId: id, diff: { packId: pack.id, version: pack.version, rules: pack.rules.length } });
    });
    return { id };
  }

  /** Rule-level diff vs the active pack, plus the schedule impact on the actor's visible clients for one FY. */
  diffPack(a: RequestActor, id: string, fy?: number) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const row = (await tx.query('SELECT * FROM rule_pack WHERE id = $1', [id])).rows[0];
      if (!row) throw new NotFoundException();
      const active = await this.packs.active(tx, a.tenantId);
      const next = loadPack(row.pack);
      const key = (r: RulePack['rules'][number]) => `${r.id}@${r.effectiveFrom}`;
      const before = new Map(active.pack.rules.map((r) => [key(r), r])); const after = new Map(next.rules.map((r) => [key(r), r]));
      const added = [...after.keys()].filter((k) => !before.has(k));
      const removed = [...before.keys()].filter((k) => !after.has(k));
      const changed = [...after.entries()].filter(([k, r]) => before.has(k) && JSON.stringify(before.get(k)) !== JSON.stringify(r)).map(([k, r]) => ({
        rule: k, fields: Object.keys(r).filter((f) => JSON.stringify((before.get(k) as Record<string, unknown>)[f]) !== JSON.stringify((r as Record<string, unknown>)[f])),
      }));
      const year = fy ?? fyOfDate(todayIst());
      const clients = (await this.visibleClients(tx, a)).map((c) => c.facts);
      const exts = await approvedExtensions(tx);
      const impact = diffSchedules(schedule({ pack: active.pack, clients, fy: year, extensions: exts }), schedule({ pack: next, clients, fy: year, extensions: exts }));
      return {
        from: { id: active.id, version: active.pack.version }, to: { id: row.id, version: next.version, status: row.status }, added, removed, changed,
        impact: { fy: year, dueDatesChanged: impact.dueDatesChanged, clientsAffected: impact.clientsAffected, changes: impact.changes.slice(0, 500) },
      };
    });
  }

  async approvePack(a: RequestActor, id: string) {
    requireFirmWide(a, 'compliance', 'approve');
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.packs.active(tx, a.tenantId);
      const row = (await tx.query('SELECT * FROM rule_pack WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new NotFoundException();
      if (row.status !== 'draft') throw new BadRequestException({ message: 'Only drafts can be approved', code: 'not_draft' });
      const prev = (await tx.query(`UPDATE rule_pack SET status = 'superseded' WHERE status = 'approved' RETURNING id, pack_version`)).rows[0];
      await tx.query(`UPDATE rule_pack SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [id, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'rule_pack.approved', entity: 'rule_pack', entityId: id, diff: { version: row.pack_version, supersedes: prev?.pack_version ?? null } });
    });
  }

  // ---------- Due-date extensions ----------
  listExtensions(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query('SELECT * FROM rule_extension ORDER BY created_at DESC LIMIT 500')).rows.map(presentExt));
  }

  async createExtension(a: RequestActor, i: { ruleId: string; periodKey: string; newDueDate: string; scope?: Extension['scope']; notification?: string | null }) {
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { pack } = await this.packs.active(tx, a.tenantId);
      const fy = fyOfPeriodKey(i.periodKey);
      const proto = pack.rules.find((r) => r.id === i.ruleId);
      if (!proto) throw new BadRequestException({ message: 'Unknown rule', code: 'unknown_rule' });
      if (fy === null || !periodsForFy(proto, fy).some((p) => p.key === i.periodKey)) throw new BadRequestException({ message: 'Period does not belong to this rule', code: 'bad_period' });
      await tx.query(`INSERT INTO rule_extension (id, tenant_id, rule_id, period_key, new_due_date, scope, notification, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, a.tenantId, i.ruleId, i.periodKey, i.newDueDate, JSON.stringify(i.scope ?? {}), i.notification ?? null, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'rule_extension.created', entity: 'rule_extension', entityId: id, diff: i });
    });
    return { id };
  }

  private async visibleClients(tx: Tx, a: RequestActor) {
    const p = new Params();
    return loadClientsWithFacts(tx, a.superAdmin ? 'TRUE' : `${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'compliance', 'view', p)}`, p.values);
  }

  /** "N due dates / M clients" + the open tasks that would move. Over the actor's visible clients. */
  private async impactTx(tx: Tx, a: RequestActor, id: string) {
    const e = (await tx.query('SELECT * FROM rule_extension WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw new NotFoundException();
    const ext: Extension = { id: e.id, ruleId: e.rule_id, periodKey: e.period_key, newDueDate: ymd(e.new_due_date)!, scope: e.scope ?? {} };
    const { pack } = await this.packs.active(tx, a.tenantId);
    const fy = fyOfPeriodKey(ext.periodKey)!;
    const clients = await this.visibleClients(tx, a);
    const facts = clients.map((c) => c.facts);
    const others = (await approvedExtensions(tx)).filter((x) => x.id !== ext.id);
    const before = schedule({ pack, clients: facts, fy, extensions: others });
    const after = schedule({ pack, clients: facts, fy, extensions: [ext, ...others] });
    const diff = diffSchedules(before, after);
    const inScope = new Set(clients.filter((c) => matches(ext.scope, c.facts)).map((c) => c.row.id as string));
    const tasks = (await tx.query(
      `SELECT t.*, c.name AS client_name FROM task t JOIN client c ON c.id = t.client_id
       WHERE t.deleted_at IS NULL AND t.outcome IS NULL AND t.status NOT IN ('done','cancelled') AND t.rule_id = $1 AND t.period_key = $2`, [ext.ruleId, ext.periodKey])).rows
      .filter((t) => inScope.has(t.client_id) && ymd(t.statutory_due) !== ext.newDueDate);
    return { e, ext, diff, tasks };
  }

  async impact(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { ext, diff, tasks } = await this.impactTx(tx, a, id);
      return {
        extension: { id: ext.id, ruleId: ext.ruleId, periodKey: ext.periodKey, newDueDate: ext.newDueDate },
        dueDatesChanged: diff.dueDatesChanged, clientsAffected: diff.clientsAffected, changes: diff.changes.slice(0, 500),
        tasksToMove: tasks.length,
        tasks: tasks.slice(0, 500).map((t) => ({ id: t.id, clientId: t.client_id, clientName: t.client_name, title: t.title, status: t.status, from: ymd(t.statutory_due), to: ext.newDueDate })),
      };
    });
  }

  /** Approve: future auto-created tasks use the new date; open tasks move (statutory due and act-by shift by the same delta). */
  async approveExtension(a: RequestActor, id: string) {
    requireFirmWide(a, 'compliance', 'approve');
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      // Firm-wide decision: affected tasks are computed over every client, not just the approver's.
      const { e, ext, tasks } = await this.impactTx(tx, systemActor(a.tenantId), id);
      if (e.status !== 'draft') throw new BadRequestException({ message: 'Only drafts can be approved', code: 'not_draft' });
      let cursor = 0;
      for (const t of tasks) {
        const from = ymd(t.statutory_due); const act = ymd(t.act_by);
        let nextAct = act && from ? dates.addDays(act, dayNo(ext.newDueDate) - dayNo(from)) : null;
        if (nextAct && nextAct > ext.newDueDate) nextAct = ext.newDueDate;
        const res = await this.sync.serverPatch(tx, a, 'task', t.id, { statutory_due: ext.newDueDate, act_by: nextAct, extension_id: ext.id });
        cursor = Math.max(cursor, res?.cursor ?? 0);
      }
      await tx.query(`UPDATE rule_extension SET status = 'approved', approved_by = $2, approved_at = now(), tasks_moved = $3 WHERE id = $1`, [id, a.userId, tasks.length]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'rule_extension.approved', entity: 'rule_extension', entityId: id,
        diff: { ruleId: ext.ruleId, periodKey: ext.periodKey, newDueDate: ext.newDueDate, tasksMoved: tasks.map((t) => t.id) } });
      return { cursor, moved: tasks.length };
    });
    if (r.cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
    return { tasksMoved: r.moved };
  }

  // ---------- Matrix ----------
  /** Installs the firm's active rule pack on first use (a write) — called before read-only report runs. */
  async ensurePack(a: RequestActor) { await this.db.tenantTx(a.tenantId, (tx) => this.packs.active(tx, a.tenantId)); }

  matrix(a: RequestActor, q: { from: string; to: string; asOf?: string; ruleIds?: string[] }) {
    if (q.to < q.from || dayNo(q.to) - dayNo(q.from) > 366) throw new BadRequestException('Range must be 0–366 days');
    return this.db.tenantTx(a.tenantId, (tx) => this.matrixTx(tx, a, q));
  }
  /** Same, on the caller's transaction (report engine: one READ ONLY connection + statement timeout). */
  async matrixTx(tx: Tx, a: RequestActor, q: { from: string; to: string; asOf?: string; ruleIds?: string[] }) {
    if (q.to < q.from || dayNo(q.to) - dayNo(q.from) > 366) throw new BadRequestException('Range must be 0–366 days');
    {
      const { pack } = await this.packs.active(tx, a.tenantId);
      const clients = (await this.visibleClients(tx, a)).slice(0, 2000);
      const facts = clients.map((c) => c.facts);
      const exts = await approvedExtensions(tx);
      const asOf = q.asOf ?? todayIst();
      const items: ReturnType<typeof schedule> = [];
      for (let fy = fyOfDate(q.from) - 1; fy <= fyOfDate(q.to); fy++) {
        items.push(...schedule({ pack, clients: facts, fy, extensions: exts }).filter((i) => i.statutoryDue >= q.from && i.statutoryDue <= q.to && (!q.ruleIds || q.ruleIds.includes(i.ruleId))));
      }
      const tasks = new Map((await tx.query(
        `SELECT id, client_id, rule_id, period_key, status, outcome FROM task WHERE deleted_at IS NULL AND rule_id IS NOT NULL AND client_id = ANY($1)`,
        [clients.map((c) => c.row.id)])).rows.map((t) => [`${t.client_id}|${t.rule_id}|${t.period_key}`, t]));
      const ruleIds = [...new Set(items.map((i) => i.ruleId))];
      return {
        from: q.from, to: q.to, asOf,
        rules: ruleIds.map((id) => { const r = pack.rules.find((x) => x.id === id)!; return { id, form: r.form, title: r.title, regime: r.regime, verified: r.verified }; }),
        clients: clients.filter((c) => items.some((i) => i.clientId === c.row.id)).map((c) => ({ id: c.row.id, name: c.row.name, fileNo: c.row.file_no })),
        cells: items.map((i) => {
          const t = tasks.get(`${i.clientId}|${i.ruleId}|${i.period.key}`);
          const done = !!t && (t.status === 'done' || t.outcome === 'billed' || t.outcome === 'free');
          const state = done ? 'done' : i.statutoryDue < asOf ? 'overdue' : t ? 'open' : 'not_created';
          return { clientId: i.clientId, ruleId: i.ruleId, periodKey: i.period.key, periodLabel: i.period.label, statutoryDue: i.statutoryDue, actBy: i.actBy,
            extensionId: i.extensionId ?? null, taskId: t?.id ?? null, taskStatus: t?.status ?? null, state };
        }),
      };
    }
  }

  // ---------- Late fees (indicative) ----------
  lateFee(i: LateFeeInput) {
    const table = this.rules.lateFees;
    const r = computeLateFee(table, i);
    const rule = ruleInForce(this.rules.pack, i.ruleId, i.dueDate) ?? this.rules.pack.rules.find((x) => x.id === i.ruleId);
    return { ...r, form: rule?.form ?? null, penaltyHint: rule?.penaltyHint ?? null, table: { id: table.id, version: table.version, notes: table.notes ?? null },
      disclaimer: 'Indicative only — rates are unverified sample data. Confirm against the official notification before advising a client.' };
  }
}
