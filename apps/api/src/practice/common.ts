import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { can, clientCtx, DEFAULT_EXPIRY_THRESHOLDS, effectiveScope, type Action, type Module } from '@worko/domain';
import { z } from 'zod';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params, visibilityOf } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';

/** Firm settings for Phase 8 (data, not code). */
export const practiceSettingsSchema = z.object({
  notices: z.object({
    taskBufferDays: z.number().int().min(0).max(60).default(7),
    /** Escalate when the response is overdue, or a hearing is this close without preparation marked done. */
    hearingPrepDays: z.number().int().min(0).max(30).default(3),
    escalateAfterMinutes: z.number().int().min(15).max(10_080).default(240),
    hearingReminderMinutesBefore: z.array(z.number().int().min(5).max(10_080)).max(5).default([1440]),
  }).default({}),
  dsc: z.object({ thresholds: z.array(z.number().int().min(0).max(365)).min(1).max(10).default(DEFAULT_EXPIRY_THRESHOLDS), renewalTaskDays: z.number().int().min(0).max(365).default(30) }).default({}),
  licences: z.object({ thresholds: z.array(z.number().int().min(0).max(365)).min(1).max(10).default(DEFAULT_EXPIRY_THRESHOLDS), renewalTaskDays: z.number().int().min(0).max(365).default(30) }).default({}),
  pbc: z.object({ reminderEveryDays: z.number().int().min(1).max(30).default(3), maxReminders: z.number().int().min(0).max(20).default(5), channel: z.enum(['email', 'whatsapp', 'sms']).default('email') }).default({}),
  /** AI extraction sends document text to an external model: off unless the firm opts in (D115). */
  ai: z.object({ noticeExtraction: z.boolean().default(false) }).default({}),
}).strict();
export type PracticeSettings = z.infer<typeof practiceSettingsSchema>;

export async function loadPracticeSettings(tx: Tx): Promise<PracticeSettings> {
  const s = (await tx.query('SELECT settings FROM practice_settings LIMIT 1')).rows[0]?.settings;
  const p = practiceSettingsSchema.safeParse(s ?? {});
  return p.success ? p.data : practiceSettingsSchema.parse({});
}

/**
 * A client row visible for `clients:view` AND `<module>:view`, else 404; then `<module>:<action>` or 403 (CLAUDE.md:
 * invisible rows answer 404).
 */
export async function clientFor(tx: Tx, a: RequestActor, clientId: unknown, module: Module, action: Action = 'view') {
  const c = typeof clientId === 'string' ? (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0] : undefined;
  const ctx = c && clientCtx(visibilityOf(c));
  if (!c || !can(a, 'clients', 'view', ctx) || !can(a, module, 'view', ctx)) throw new NotFoundException('Not found');
  if (!can(a, module, action, ctx)) throw new ForbiddenException();
  return c as Record<string, unknown> & { id: string; name: string; partner_id: string | null; manager_id: string | null };
}

/** SQL filter for rows joined to client `c` that the actor sees in `module`. */
export const visibleSql = (a: RequestActor, module: Module, p: Params, c = 'c') => `(${clientScopeSql(a, 'clients', 'view', p, c)} AND ${clientScopeSql(a, module, 'view', p, c)})`;

export function requireFirmWide(a: RequestActor, module: Module, action: Action) {
  if (a.superAdmin) return;
  if (effectiveScope(a, module, action)?.scope !== 'all') throw new ForbiddenException(`Needs firm-wide ${module}:${action}`);
}

/** Active staff user or 400. */
export async function staffUser(tx: Tx, id: string | null | undefined, field: string) {
  if (!id) return null;
  const u = (await tx.query(`SELECT id, name FROM app_user WHERE id = $1 AND status = 'active' AND deleted_at IS NULL AND kind = 'staff'`, [id])).rows[0];
  if (!u) throw new BadRequestException({ message: `Unknown user in ${field}`, code: `invalid:${field}` });
  return u as { id: string; name: string };
}

/** Server-created task (source 'auto', rule id ties it to its record); returns id + cursor. */
export async function createLinkedTask(tx: Tx, tenantId: string, t: {
  clientId: string | null; title: string; description?: string | null; statutoryDue: string | null; actBy: string | null; assigneeId: string | null;
  reviewerId?: string | null; managerId?: string | null; ruleId: string; priority?: 'normal' | 'high' | 'urgent'; createdBy: string | null;
}) {
  const id = uuidv7();
  const actBy = t.actBy && t.statutoryDue && t.actBy > t.statutoryDue ? t.statutoryDue : t.actBy;
  const r = await tx.query(`INSERT INTO task (id, tenant_id, client_id, title, description, status, priority, statutory_due, act_by, assignee_id, reviewer_id, manager_id,
      source, rule_id, created_by, updated_by, device_id) VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,'auto',$12,$13,$13,'server') RETURNING sync_cursor`,
    [id, tenantId, t.clientId, t.title.slice(0, 300), t.description ?? null, t.priority ?? 'normal', t.statutoryDue, actBy, t.assigneeId, t.reviewerId ?? null, t.managerId ?? null, t.ruleId, t.createdBy]);
  return { id, cursor: Number(r.rows[0].sync_cursor) };
}

/** pg `date` (local-midnight Date) or string → 'YYYY-MM-DD'. */
export const ymd = (v: unknown): string | null => v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : typeof v === 'string' ? v.slice(0, 10) : null;

/** A real calendar date (2026-13-45 is a 400, not a database error). */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'Invalid date');
export class Cursor { v = 0; add(c: number | null | undefined) { if (c && c > this.v) this.v = c; } }
export { Params };

/** Users (active staff) who can still see `clientId` for clients:view AND `module`:view — alerts never reach anyone who lost access. */
export async function usersSeeing(tx: Tx, userIds: Array<string | null | undefined>, clientId: string | null, module: Module): Promise<string[]> {
  const out: string[] = [];
  const c = clientId ? (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0] : null;
  if (clientId && !c) return out;
  for (const id of new Set(userIds.filter((x): x is string => !!x))) {
    const u = (await tx.query(`SELECT id, branch_id FROM app_user WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [id])).rows[0];
    if (!u) continue;
    const actor = { userId: u.id, branchId: u.branch_id, teamIds: await loadTeamIds(tx, u.id), roles: await loadUserRoles(tx, u.id) };
    if (!c) { if (effectiveScope(actor, module, 'view')) out.push(id); continue; }
    const ctx = clientCtx(visibilityOf(c));
    if (can(actor, 'clients', 'view', ctx) && can(actor, module, 'view', ctx)) out.push(id);
  }
  return out;
}

/** For escalations of Phase 8 notifications: the client + module behind the entity, or null if not a client record. */
export async function entityClient(tx: Tx, entityType: string | null, entityId: string | null): Promise<{ clientId: string | null; module: Module } | null> {
  if (!entityType || !entityId) return null;
  const map: Record<string, [string, Module]> = { notice: ['notice', 'notices'], notice_hearing: ['notice_hearing', 'notices'], dsc: ['dsc', 'dsc'], licence: ['licence', 'compliance'] };
  const m = map[entityType];
  if (!m) return null;
  const r = (await tx.query(`SELECT client_id FROM ${m[0]} WHERE id = $1`, [entityId])).rows[0];
  return r ? { clientId: r.client_id, module: m[1] } : null;
}

/** Heuristic for secrets typed into free text (DSC notes/labels/custody fields): "PIN: 1234", "password=abc". D117/KNOWN_GAPS. */
export const SECRET_TEXT_RX = /\b(pin|password|passwd|pwd|passcode)\b\s*(is\s*)?[:=-]?\s*\S+/i;
