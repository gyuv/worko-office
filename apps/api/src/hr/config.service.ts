import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { accrualSchema, canSeeCost, hrSettingsSchema, isValidCidr, type Accrual, type HrSettings } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { isoDay, loadHrSettings, num } from './common.js';

export type LeaveTypeIn = {
  key: string; name: string; paid?: boolean; tracked?: boolean; appliesToRoles?: string[]; accrual?: Accrual; carryForwardCap?: number | null;
  allowHalfDay?: boolean; maxDaysPerRequest?: number | null; compOff?: boolean; active?: boolean; sort?: number; notes?: string | null;
};

const sqlErr = (e: unknown) => (e as { code?: string }).code;

/** Firm HR configuration (all data, firm-wide hr:edit) and sensitive cost rates (firm-wide settings:edit + cost visibility). */
@Injectable()
export class HrConfigService {
  constructor(private db: DbService, private audit: AuditService, private realtime: RealtimeService) {}

  private cursor(tenantId: string, c: unknown) { if (c) this.realtime.publish({ type: 'changed', tenantId, cursor: Number(c) }); }
  private rec(tx: Tx, a: RequestActor, action: string, entity: string, entityId: string | null, diff: unknown) {
    return this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action, entity, entityId, diff });
  }

  settings(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => loadHrSettings(tx)); }

  async putSettings(a: RequestActor, i: unknown): Promise<HrSettings> {
    requireFirmWide(a, 'hr', 'edit');
    const s = hrSettingsSchema.parse(i);
    const bad = s.attendance.ipAllowList.find((c) => !isValidCidr(c));
    if (bad) throw new BadRequestException({ message: `Invalid CIDR ${bad}`, code: 'invalid_cidr' });
    if (s.compOff.halfDayMinutes > s.compOff.fullDayMinutes) throw new BadRequestException({ message: 'Half-day threshold above full day', code: 'invalid_comp_off' });
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO hr_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id) DO UPDATE SET settings = $2, updated_by = $3, updated_at = now()`, [a.tenantId, JSON.stringify(s), a.userId]);
      await this.rec(tx, a, 'hr_settings.updated', 'hr_settings', null, s);
      return s;
    });
  }

  // ---------- Holidays ----------
  holidays(a: RequestActor, q: { from?: string; to?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT * FROM holiday WHERE deleted_at IS NULL AND ($1::date IS NULL OR on_date >= $1::date) AND ($2::date IS NULL OR on_date <= $2::date)
      ORDER BY on_date`, [q.from ?? null, q.to ?? null])).rows
      .map((r) => ({ id: r.id, date: isoDay(r.on_date), name: r.name, branchId: r.branch_id, optional: r.optional })));
  }
  async addHoliday(a: RequestActor, i: { date: string; name: string; branchId?: string | null; optional?: boolean }) {
    requireFirmWide(a, 'hr', 'edit');
    const id = uuidv7();
    const c = await this.db.tenantTx(a.tenantId, async (tx) => {
      try {
        await tx.query('SAVEPOINT h');
        const r = await tx.query('INSERT INTO holiday (id, tenant_id, on_date, name, branch_id, optional, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING sync_cursor',
          [id, a.tenantId, i.date, i.name, i.branchId ?? null, i.optional ?? false, a.userId]);
        await this.rec(tx, a, 'holiday.created', 'holiday', id, i);
        return r.rows[0].sync_cursor;
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT h');
        if (sqlErr(e) === '23505') throw new ConflictException({ message: 'A holiday already exists on that date', code: 'holiday_exists' });
        if (sqlErr(e) === '23503') throw new BadRequestException({ message: 'Unknown branch', code: 'invalid_branch' });
        throw e;
      }
    });
    this.cursor(a.tenantId, c);
    return { id };
  }
  async removeHoliday(a: RequestActor, id: string) {
    requireFirmWide(a, 'hr', 'edit');
    const c = await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await tx.query('UPDATE holiday SET deleted_at = now(), updated_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING sync_cursor', [id, a.userId]);
      if (!r.rowCount) throw new NotFoundException();
      await this.rec(tx, a, 'holiday.deleted', 'holiday', id, null);
      return r.rows[0].sync_cursor;
    });
    this.cursor(a.tenantId, c);
  }

  // ---------- Office locations (geofences) ----------
  locations(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query('SELECT * FROM office_location WHERE deleted_at IS NULL ORDER BY name')).rows
      .map((r) => ({ id: r.id, branchId: r.branch_id, name: r.name, lat: Number(r.lat), lng: Number(r.lng), radiusM: r.radius_m, active: r.active })));
  }
  async saveLocation(a: RequestActor, id: string | null, i: { branchId?: string | null; name?: string; lat?: number; lng?: number; radiusM?: number; active?: boolean; deleted?: boolean }) {
    requireFirmWide(a, 'hr', 'edit');
    const lid = id ?? uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      if (!id) {
        if (i.name === undefined || i.lat === undefined || i.lng === undefined || i.radiusM === undefined) throw new BadRequestException('name, lat, lng and radiusM are required');
        await tx.query('INSERT INTO office_location (id, tenant_id, branch_id, name, lat, lng, radius_m, active, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [lid, a.tenantId, i.branchId ?? null, i.name, i.lat, i.lng, i.radiusM, i.active ?? true, a.userId]);
      } else {
        const r = await tx.query(`UPDATE office_location SET name = COALESCE($2, name), lat = COALESCE($3, lat), lng = COALESCE($4, lng), radius_m = COALESCE($5, radius_m),
          active = COALESCE($6, active), deleted_at = CASE WHEN $7 THEN now() ELSE deleted_at END, updated_by = $8 WHERE id = $1 AND deleted_at IS NULL`,
          [id, i.name ?? null, i.lat ?? null, i.lng ?? null, i.radiusM ?? null, i.active ?? null, !!i.deleted, a.userId]);
        if (!r.rowCount) throw new NotFoundException();
      }
      // The office position is firm data, not personal data: logging it is fine.
      await this.rec(tx, a, id ? 'office_location.updated' : 'office_location.created', 'office_location', lid, i);
    });
    return { id: lid };
  }

  // ---------- Leave types ----------
  leaveTypes(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query('SELECT * FROM leave_type WHERE deleted_at IS NULL ORDER BY sort, key')).rows.map(presentLeaveType));
  }
  async saveLeaveType(a: RequestActor, id: string | null, i: Partial<LeaveTypeIn>) {
    requireFirmWide(a, 'hr', 'edit');
    const lid = id ?? uuidv7();
    const c = await this.db.tenantTx(a.tenantId, async (tx) => {
      const acc = i.accrual ? JSON.stringify(accrualSchema.parse(i.accrual)) : null;
      let r;
      try {
        await tx.query('SAVEPOINT lt');
        r = id
          ? await tx.query(`UPDATE leave_type SET name = COALESCE($2, name), paid = COALESCE($3, paid), tracked = COALESCE($4, tracked), applies_to_roles = COALESCE($5, applies_to_roles),
              accrual = COALESCE($6::jsonb, accrual), carry_forward_cap = CASE WHEN $7 THEN $8 ELSE carry_forward_cap END, allow_half_day = COALESCE($9, allow_half_day),
              max_days_per_request = CASE WHEN $10 THEN $11 ELSE max_days_per_request END, comp_off = COALESCE($12, comp_off), active = COALESCE($13, active), sort = COALESCE($14, sort),
              notes = COALESCE($15, notes), updated_by = $16 WHERE id = $1 AND deleted_at IS NULL RETURNING sync_cursor`,
          [id, i.name ?? null, i.paid ?? null, i.tracked ?? null, i.appliesToRoles ?? null, acc, i.carryForwardCap !== undefined, i.carryForwardCap ?? null, i.allowHalfDay ?? null,
            i.maxDaysPerRequest !== undefined, i.maxDaysPerRequest ?? null, i.compOff ?? null, i.active ?? null, i.sort ?? null, i.notes ?? null, a.userId])
          : await tx.query(`INSERT INTO leave_type (id, tenant_id, key, name, paid, tracked, applies_to_roles, accrual, carry_forward_cap, allow_half_day, max_days_per_request, comp_off, active, sort, notes, updated_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::jsonb, '{"kind":"none","days":0}'),$9,$10,$11,$12,$13,$14,$15,$16) RETURNING sync_cursor`,
          [lid, a.tenantId, i.key, i.name, i.paid ?? true, i.tracked ?? true, i.appliesToRoles ?? [], acc, i.carryForwardCap ?? null, i.allowHalfDay ?? true, i.maxDaysPerRequest ?? null,
            i.compOff ?? false, i.active ?? true, i.sort ?? 0, i.notes ?? null, a.userId]);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT lt');
        if (sqlErr(e) === '23505') throw new ConflictException({ message: 'Leave type key exists', code: 'leave_type_exists' });
        throw e;
      }
      if (!r.rowCount) throw new NotFoundException();
      await this.rec(tx, a, id ? 'leave_type.updated' : 'leave_type.created', 'leave_type', lid, i);
      return r.rows[0].sync_cursor;
    });
    this.cursor(a.tenantId, c);
    return { id: lid };
  }

  // ---------- Expense categories (policy limits as data) ----------
  categories(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query('SELECT * FROM expense_category WHERE deleted_at IS NULL ORDER BY key')).rows
      .map((r) => ({ id: r.id, key: r.key, name: r.name, limitPaise: num(r.limit_paise), limitMode: r.limit_mode, active: r.active })));
  }
  async saveCategory(a: RequestActor, i: { key: string; name: string; limitPaise?: number | null; limitMode?: 'warn' | 'block'; active?: boolean }) {
    requireFirmWide(a, 'hr', 'edit');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = (await tx.query('SELECT id FROM expense_category WHERE key = $1 AND deleted_at IS NULL FOR UPDATE', [i.key])).rows[0];
      const id = cur?.id ?? uuidv7();
      if (cur) await tx.query('UPDATE expense_category SET name = $2, limit_paise = $3, limit_mode = $4, active = $5, updated_by = $6 WHERE id = $1', [id, i.name, i.limitPaise ?? null, i.limitMode ?? 'warn', i.active ?? true, a.userId]);
      else await tx.query('INSERT INTO expense_category (id, tenant_id, key, name, limit_paise, limit_mode, active, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, a.tenantId, i.key, i.name, i.limitPaise ?? null, i.limitMode ?? 'warn', i.active ?? true, a.userId]);
      await this.rec(tx, a, 'expense_category.saved', 'expense_category', id, i);
      return { id };
    });
  }

  // ---------- Capacity per user ----------
  async setCapacity(a: RequestActor, userId: string, weeklyMinutes: number) {
    requireFirmWide(a, 'hr', 'edit');
    await this.db.tenantTx(a.tenantId, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM app_user WHERE id = $1 AND deleted_at IS NULL', [userId])).rowCount) throw new NotFoundException();
      await tx.query(`INSERT INTO hr_profile (tenant_id, user_id, weekly_capacity_minutes, updated_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (user_id) DO UPDATE SET weekly_capacity_minutes = $3, updated_by = $4, updated_at = now()`, [a.tenantId, userId, weeklyMinutes, a.userId]);
      await this.rec(tx, a, 'hr_profile.updated', 'app_user', userId, { weeklyCapacityMinutes: weeklyMinutes });
    });
  }

  // ---------- Cost rates (sensitive, D87) ----------
  private requireCost(a: RequestActor, write: boolean) {
    if (!canSeeCost(a)) throw new ForbiddenException({ message: 'Cost rates are restricted', code: 'cost_hidden' });
    if (write) requireFirmWide(a, 'settings', 'edit');
  }
  costRates(a: RequestActor, userId?: string) {
    this.requireCost(a, false);
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT r.*, u.name AS user_name FROM cost_rate r JOIN app_user u ON u.id = r.user_id
      WHERE r.deleted_at IS NULL AND ($1::uuid IS NULL OR r.user_id = $1::uuid) ORDER BY lower(u.name), r.effective_from DESC`, [userId ?? null])).rows
      .map((r) => ({ id: r.id, userId: r.user_id, userName: r.user_name, hourlyPaise: Number(r.hourly_paise), effectiveFrom: isoDay(r.effective_from), effectiveTo: isoDay(r.effective_to), notes: r.notes })));
  }
  /** New rate from a date; the previous open-ended rate of that user is end-dated the day before (history kept). */
  async addCostRate(a: RequestActor, i: { userId: string; hourlyPaise: number; effectiveFrom: string; notes?: string | null }) {
    this.requireCost(a, true);
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM app_user WHERE id = $1 AND deleted_at IS NULL AND kind = 'staff'`, [i.userId])).rowCount) throw new NotFoundException();
      await tx.query(`UPDATE cost_rate SET effective_to = ($3::date - 1), updated_by = $4 WHERE user_id = $1 AND deleted_at IS NULL AND effective_to IS NULL AND effective_from < $3::date AND id <> $2`,
        [i.userId, id, i.effectiveFrom, a.userId]);
      try {
        await tx.query('SAVEPOINT cr');
        await tx.query('INSERT INTO cost_rate (id, tenant_id, user_id, hourly_paise, effective_from, notes, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
          [id, a.tenantId, i.userId, i.hourlyPaise, i.effectiveFrom, i.notes ?? null, a.userId]);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT cr');
        if (sqlErr(e) === '23505') throw new ConflictException({ message: 'A rate already starts on that date', code: 'cost_rate_exists' });
        throw e;
      }
      await this.rec(tx, a, 'cost_rate.created', 'cost_rate', id, { userId: i.userId, effectiveFrom: i.effectiveFrom, hourlyPaise: i.hourlyPaise });
    });
    return { id };
  }
  async removeCostRate(a: RequestActor, id: string) {
    this.requireCost(a, true);
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await tx.query('UPDATE cost_rate SET deleted_at = now(), updated_by = $2 WHERE id = $1 AND deleted_at IS NULL', [id, a.userId]);
      if (!r.rowCount) throw new NotFoundException();
      await this.rec(tx, a, 'cost_rate.deleted', 'cost_rate', id, null);
    });
  }
}

export const presentLeaveType = (r: Record<string, unknown>) => ({
  id: r.id, key: r.key, name: r.name, paid: r.paid, tracked: r.tracked, appliesToRoles: r.applies_to_roles, accrual: r.accrual, carryForwardCap: num(r.carry_forward_cap),
  allowHalfDay: r.allow_half_day, maxDaysPerRequest: num(r.max_days_per_request), compOff: r.comp_off, active: r.active, sort: r.sort, notes: r.notes,
});
