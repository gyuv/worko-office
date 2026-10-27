import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { can, clientCtx, GST_STATES, hiddenFieldsOf, panFromGstin, type ClientVisibility } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { requireElevated } from '../auth/elevation.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { GSTIN_LOOKUP, type GstinLookupProvider } from '../lookup/gstin.provider.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SYNC_TABLES, visibilityOf } from '../sync/registry.js';
import { SyncService } from '../sync/sync.service.js';
import type { AccessIn, ClientCreate, ClientPatch } from './clients.schemas.js';
import { clientScopeSql, Params } from './scope.js';
import { VisibilityService } from './visibility.service.js';

const COLS: Record<string, string> = {
  name: 'name', tradeName: 'trade_name', fileNo: 'file_no', entityType: 'entity_type', pan: 'pan', tan: 'tan', cin: 'cin', udyam: 'udyam', iec: 'iec',
  dob: 'dob', email: 'email', phone: 'phone', addresses: 'addresses', source: 'source', status: 'status', tags: 'tags', custom: 'custom', notes: 'notes',
  complianceProfile: 'compliance_profile',
};
const JSON_COLS = new Set(['addresses', 'custom', 'compliance_profile', 'bank_accounts_masked']);
const db = (c: string, v: unknown) => (JSON_COLS.has(c) && v !== undefined && v !== null ? JSON.stringify(v) : v);
const unique = (xs: string[]) => [...new Set(xs)];

/** Public shape of a client for API responses (hidden fields removed per actor). */
function present(a: RequestActor, r: Record<string, unknown>) {
  const out: Record<string, unknown> = {
    id: r.id, fileNo: r.file_no, name: r.name, tradeName: r.trade_name, entityType: r.entity_type, pan: r.pan, tan: r.tan, cin: r.cin,
    udyam: r.udyam, iec: r.iec, aadhaarLast4: r.aadhaar_last4, bankAccounts: r.bank_accounts_masked, dob: r.dob, email: r.email, phone: r.phone,
    addresses: r.addresses, source: r.source, status: r.status, tags: r.tags, custom: r.custom, notes: r.notes, complianceProfile: r.compliance_profile,
    branchId: r.branch_id, partnerId: r.partner_id, managerId: r.manager_id, teamId: r.team_id, staffIds: r.staff_ids, groupIds: r.group_ids,
    sensitive: r.sensitive, allowedUserIds: r.allowed_user_ids, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
    primaryGstin: r.primary_gstin ?? undefined,
  };
  // Role field-hiding, e.g. 'client.bank_accounts' → drop `bankAccounts`; 'client.aadhaar' → drop `aadhaarLast4`.
  for (const f of hiddenFieldsOf(a)) {
    if (!f.startsWith('client.')) continue;
    const key = f.slice(7).replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
    delete out[key];
    if (key === 'aadhaar') delete out.aadhaarLast4;
  }
  return out;
}

@Injectable()
export class ClientsService {
  constructor(
    private dbs: DbService, private audit: AuditService, private keys: KeyService, private visibility: VisibilityService,
    private sync: SyncService, private realtime: RealtimeService, @Inject(GSTIN_LOOKUP) private gstin: GstinLookupProvider,
  ) {}

  /** Loads a client the actor may act on, or 404 (never 403: don't confirm existence of invisible clients). */
  async loadFor(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit' | 'delete' | 'reveal' = 'view', module: 'clients' | 'vault' = 'clients') {
    const r = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!r || !can(a, 'clients', 'view', clientCtx(visibilityOf(r)))) throw new NotFoundException('Client not found');
    if ((action !== 'view' || module !== 'clients') && !can(a, module, action, clientCtx(visibilityOf(r)))) throw new ForbiddenException();
    return r;
  }

  async list(a: RequestActor, q: { q?: string; status?: string; groupId?: string; limit: number; offset: number }) {
    return this.dbs.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = [clientScopeSql(a, 'clients', 'view', p), 'c.deleted_at IS NULL'];
      if (q.status) where.push(`c.status = ${p.add(q.status)}`);
      if (q.groupId) where.push(`${p.add(q.groupId)}::uuid = ANY(c.group_ids)`);
      if (q.q) {
        const term = p.add(q.q.trim());
        where.push(`(lower(c.name) LIKE '%' || lower(${term}) || '%' OR lower(coalesce(c.trade_name,'')) LIKE '%' || lower(${term}) || '%'
          OR c.pan = upper(${term}) OR lower(coalesce(c.file_no,'')) = lower(${term}) OR c.phone LIKE '%' || ${term}
          OR EXISTS (SELECT 1 FROM client_registration r WHERE r.client_id = c.id AND r.deleted_at IS NULL AND r.number = upper(${term})))`);
      }
      const rows = (await tx.query(
        `SELECT c.*, (SELECT r.number FROM client_registration r WHERE r.client_id = c.id AND r.kind = 'GSTIN' AND r.deleted_at IS NULL ORDER BY r.is_primary DESC, r.number LIMIT 1) AS primary_gstin,
                count(*) OVER () AS total
         FROM client c WHERE ${where.join(' AND ')} ORDER BY lower(c.name), c.id LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total ?? 0), items: rows.map((r) => present(a, r)) };
    });
  }

  async get(a: RequestActor, id: string) {
    return this.dbs.tenantTx(a.tenantId, async (tx) => {
      const c = await this.loadFor(tx, a, id);
      const regs = (await tx.query(`SELECT id, kind, number, state_code AS "stateCode", status, registered_on AS "registeredOn", is_primary AS "isPrimary" FROM client_registration WHERE client_id = $1 AND deleted_at IS NULL ORDER BY kind, number`, [id])).rows;
      const contacts = (await tx.query(`SELECT id, name, role, email, phone, whatsapp, dob, anniversary, is_primary AS "isPrimary", notes FROM contact WHERE client_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, name`, [id])).rows;
      const groups = (await tx.query(`SELECT id, name, kind FROM client_group WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY name`, [c.group_ids])).rows;
      const ctx = clientCtx(visibilityOf(c));
      const counts = (await tx.query(`SELECT
          (SELECT count(*) FROM document WHERE client_id = $1 AND deleted_at IS NULL)::int AS documents,
          (SELECT count(*) FROM vault_secret WHERE client_id = $1 AND deleted_at IS NULL)::int AS secrets,
          (SELECT count(*) FROM inward_entry WHERE client_id = $1 AND deleted_at IS NULL)::int AS inward,
          (SELECT count(*) FROM outward_entry WHERE client_id = $1 AND deleted_at IS NULL)::int AS outward`, [id])).rows[0];
      return {
        ...present(a, c), registrations: regs, contacts, groups, counts,
        can: { edit: can(a, 'clients', 'edit', ctx), delete: can(a, 'clients', 'delete', ctx), reveal: can(a, 'clients', 'reveal', ctx), vault: can(a, 'vault', 'view', ctx) },
      };
    });
  }

  private async validateAccess(tx: Tx, a: RequestActor, acc: AccessIn) {
    const users = unique([acc.partnerId, acc.managerId, ...(acc.staffIds ?? []), ...(acc.allowedUserIds ?? [])].filter((x): x is string => !!x));
    if (users.length) {
      const n = (await tx.query(`SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1) AND kind = 'staff' AND deleted_at IS NULL`, [users])).rows[0].n;
      if (n !== users.length) throw new BadRequestException('Unknown user');
    }
    if (acc.teamId && !(await tx.query('SELECT 1 FROM team WHERE id = $1 AND deleted_at IS NULL', [acc.teamId])).rowCount) throw new BadRequestException('Unknown team');
    if (acc.groupIds?.length && (await tx.query('SELECT count(*)::int AS n FROM client_group WHERE id = ANY($1) AND deleted_at IS NULL', [acc.groupIds])).rows[0].n !== unique(acc.groupIds).length) throw new BadRequestException('Unknown group');
    if (acc.branchId && !(await tx.query('SELECT 1 FROM branch WHERE id = $1', [acc.branchId])).rowCount) throw new BadRequestException('Unknown branch');
  }

  /** Visibility after applying `acc`; the actor must still be able to see and edit the result (no lock-out by accident) */
  private nextVisibility(a: RequestActor, cur: ClientVisibility, acc: AccessIn): ClientVisibility {
    const v: ClientVisibility = {
      branchId: acc.branchId !== undefined ? acc.branchId : cur.branchId, partnerId: acc.partnerId !== undefined ? acc.partnerId : cur.partnerId,
      managerId: acc.managerId !== undefined ? acc.managerId : cur.managerId, teamId: acc.teamId !== undefined ? acc.teamId : cur.teamId,
      staffIds: acc.staffIds ?? cur.staffIds, groupIds: acc.groupIds ?? cur.groupIds, sensitive: acc.sensitive ?? cur.sensitive,
      allowedUserIds: acc.allowedUserIds ?? cur.allowedUserIds,
    };
    // Marking sensitive always keeps the people responsible for it (and the person doing it) on the list.
    if (v.sensitive) v.allowedUserIds = unique([...v.allowedUserIds, a.userId, ...[v.partnerId, v.managerId].filter((x): x is string => !!x)]);
    return v;
  }

  private async encryptPii(tx: Tx, a: RequestActor, id: string, i: { aadhaar?: string | null; bankAccounts?: ClientCreate['bankAccounts'] }) {
    const out: Record<string, unknown> = {};
    if (i.aadhaar !== undefined) {
      const digits = i.aadhaar?.replace(/\D/g, '') ?? null;
      out.aadhaar_enc = digits ? await this.keys.encrypt(tx, a.tenantId, digits, `client:${id}:aadhaar`) : null;
      out.aadhaar_last4 = digits ? digits.slice(-4) : null;
    }
    if (i.bankAccounts !== undefined) {
      out.bank_accounts_enc = i.bankAccounts.length ? await this.keys.encrypt(tx, a.tenantId, JSON.stringify(i.bankAccounts), `client:${id}:bank`) : null;
      out.bank_accounts_masked = i.bankAccounts.map((b) => ({ bank: b.bank, ifsc: b.ifsc, last4: b.accountNo.slice(-4), holder: b.holder ?? null }));
    }
    return out;
  }

  async create(a: RequestActor, i: ClientCreate) {
    const id = uuidv7();
    const cursor = await this.dbs.tenantTx(a.tenantId, async (tx) => {
      const acc = this.nextVisibility(a, { branchId: a.branchId, partnerId: null, managerId: null, teamId: null, staffIds: [], groupIds: [], sensitive: false, allowedUserIds: [] }, i);
      // Creators who only see "own" clients must stay on the client they create.
      if (!can(a, 'clients', 'view', clientCtx(acc))) acc.staffIds = unique([...acc.staffIds, a.userId]);
      if (!can(a, 'clients', 'create', clientCtx(acc))) throw new ForbiddenException('Cannot create clients there');
      await this.validateAccess(tx, a, i);
      const gstins = i.registrations.filter((r) => r.kind === 'GSTIN');
      const pan = i.pan ?? (gstins[0] ? panFromGstin(gstins[0].number) : null);
      const row: Record<string, unknown> = {
        file_no: i.fileNo ?? null, name: i.name, trade_name: i.tradeName ?? null, entity_type: i.entityType, pan, tan: i.tan ?? null, cin: i.cin ?? null,
        udyam: i.udyam ?? null, iec: i.iec ?? null, dob: i.dob ?? null, email: i.email ?? null, phone: i.phone ?? null, addresses: i.addresses ?? [],
        source: i.source ?? null, status: i.status ?? 'active', tags: i.tags ?? [], custom: i.custom ?? {}, notes: i.notes ?? null, compliance_profile: i.complianceProfile ?? {},
        branch_id: acc.branchId, partner_id: acc.partnerId, manager_id: acc.managerId, team_id: acc.teamId, staff_ids: acc.staffIds, group_ids: acc.groupIds,
        sensitive: acc.sensitive, allowed_user_ids: acc.allowedUserIds, ...(await this.encryptPii(tx, a, id, i)),
      };
      const cols = Object.keys(row);
      let r;
      try {
        r = await tx.query(`INSERT INTO client (id, tenant_id, updated_by, field_versions, ${cols.join(', ')}) VALUES ($1, $2, $3, $4, ${cols.map((_, k) => `$${k + 5}`).join(', ')}) RETURNING sync_cursor`,
          [id, a.tenantId, a.userId, JSON.stringify(Object.fromEntries(cols.map((c) => [c, 1]))), ...cols.map((c) => db(c, row[c]))]);
      } catch (e) { this.conflict(e); }
      for (const reg of i.registrations) await this.addRegistration(tx, a, id, reg);
      for (const c of i.contacts) await this.addContact(tx, a, id, c);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'client.created', entity: 'client', entityId: id, diff: { ...row, aadhaar_enc: undefined, bank_accounts_enc: undefined } });
      return Number(r!.rows[0].sync_cursor);
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor });
    return { id };
  }

  private conflict(e: unknown): never {
    const c = e as { code?: string; constraint?: string };
    if (c.code === '23505') throw new ConflictException(c.constraint?.includes('file_no') ? 'File number already used' : c.constraint?.includes('registration') ? 'That registration number already belongs to another client' : 'Duplicate');
    throw e;
  }

  async addRegistration(tx: Tx, a: RequestActor, clientId: string, r: ClientCreate['registrations'][number]) {
    const stateCode = r.kind === 'GSTIN' ? r.number.slice(0, 2) : (r.stateCode ?? null);
    const id = uuidv7();
    try {
      await tx.query(`INSERT INTO client_registration (id, tenant_id, client_id, kind, number, state_code, status, registered_on, is_primary, updated_by, field_versions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}')`, [id, a.tenantId, clientId, r.kind, r.number, stateCode, r.status ?? null, r.registeredOn ?? null, r.isPrimary, a.userId]);
    } catch (e) { this.conflict(e); }
    return id;
  }

  async addContact(tx: Tx, a: RequestActor, clientId: string, c: ClientCreate['contacts'][number]) {
    const id = uuidv7();
    await tx.query(`INSERT INTO contact (id, tenant_id, client_id, name, role, email, phone, whatsapp, dob, anniversary, is_primary, updated_by, field_versions)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}')`, [id, a.tenantId, clientId, c.name, c.role ?? null, c.email ?? null, c.phone ?? null, c.whatsapp ?? null, c.dob ?? null, c.anniversary ?? null, c.isPrimary, a.userId]);
    return id;
  }

  /** Runs a child-record insert after checking the actor may edit the client; audits and pings devices. */
  async withEditable(a: RequestActor, clientId: string, fn: (tx: Tx) => Promise<string>, action: string, diff: unknown) {
    const id = await this.dbs.tenantTx(a.tenantId, async (tx) => {
      await this.loadFor(tx, a, clientId, 'edit');
      const childId = await fn(tx);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action, entity: action.split('.')[0]!, entityId: childId, diff });
      return childId;
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: 0 });
    return { id };
  }

  /** Field edits go through the sync layer (field versions → conflict detection with offline edits). */
  async update(a: RequestActor, id: string, p: ClientPatch) {
    const res = await this.dbs.tenantTx(a.tenantId, async (tx) => {
      await this.loadFor(tx, a, id, 'edit');
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) if (COLS[k] && v !== undefined) patch[COLS[k]!] = v;
      Object.assign(patch, await this.encryptPii(tx, a, id, { aadhaar: p.aadhaar, bankAccounts: p.bankAccounts }));
      let r;
      try { r = await this.sync.serverPatch(tx, a, 'client', id, patch); } catch (e) { this.conflict(e); }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'client.updated', entity: 'client', entityId: id, diff: { ...patch, aadhaar_enc: undefined, bank_accounts_enc: undefined } });
      return r;
    });
    if (res) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: res.cursor });
  }

  /** Who may see the client. Narrowing revokes on exactly the devices that held it; widening re-ships children. */
  async setAccess(a: RequestActor, id: string, acc: AccessIn) {
    await this.dbs.tenantTx(a.tenantId, async (tx) => {
      const cur = await this.loadFor(tx, a, id, 'edit');
      await this.validateAccess(tx, a, acc);
      const before = visibilityOf(cur);
      const after = this.nextVisibility(a, before, acc);
      if (!can(a, 'clients', 'edit', clientCtx(after))) throw new ForbiddenException('You would lose access to this client — ask someone with wider scope');
      const patch: Record<string, unknown> = {
        branch_id: after.branchId, partner_id: after.partnerId, manager_id: after.managerId, team_id: after.teamId,
        staff_ids: after.staffIds, group_ids: after.groupIds, sensitive: after.sensitive, allowed_user_ids: after.allowedUserIds,
      };
      await tx.query(`UPDATE client SET ${Object.keys(patch).map((k, n) => `${k} = $${n + 2}`).join(', ')}, updated_by = $${Object.keys(patch).length + 2} WHERE id = $1`,
        [id, ...Object.values(patch), a.userId]);
      await this.visibility.onChange(tx, a.tenantId, id, before, after);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'client.access_changed', entity: 'client', entityId: id, diff: { before, after } });
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: 0 });
  }

  async remove(a: RequestActor, id: string) {
    await this.dbs.tenantTx(a.tenantId, async (tx) => {
      await this.loadFor(tx, a, id, 'delete');
      await tx.query('UPDATE client SET deleted_at = now(), updated_by = $2 WHERE id = $1', [id, a.userId]);
      for (const t of ['contact', 'client_registration', 'vault_secret']) await tx.query(`UPDATE ${t} SET deleted_at = now() WHERE client_id = $1 AND deleted_at IS NULL`, [id]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'client.deleted', entity: 'client', entityId: id });
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: 0 });
  }

  /** Reveal decrypted Aadhaar / bank details: permission + recent step-up + audit (never cached or logged). */
  async revealPii(a: RequestActor, id: string, field: 'aadhaar' | 'bankAccounts') {
    requireElevated(a);
    return this.dbs.tenantTx(a.tenantId, async (tx) => {
      const c = await this.loadFor(tx, a, id, 'reveal');
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'client.pii_revealed', entity: 'client', entityId: id, diff: { field } });
      if (field === 'aadhaar') return { value: c.aadhaar_enc ? await this.keys.decrypt(tx, a.tenantId, c.aadhaar_enc, `client:${id}:aadhaar`) : null };
      return { value: c.bank_accounts_enc ? JSON.parse(await this.keys.decrypt(tx, a.tenantId, c.bank_accounts_enc, `client:${id}:bank`)) : [] };
    });
  }

  /**
   * Likely duplicates by PAN / GSTIN / phone / similar name. Matches the actor can't see are only counted,
   * never named, so the check can't be used to discover hidden clients.
   */
  async duplicates(a: RequestActor, i: { name?: string; pan?: string; gstin?: string; phone?: string; excludeId?: string }) {
    return this.dbs.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const conds: string[] = [];
      if (i.pan) conds.push(`c.pan = upper(${p.add(i.pan)})`);
      if (i.phone) conds.push(`c.phone = ${p.add(i.phone)} OR EXISTS (SELECT 1 FROM contact k WHERE k.client_id = c.id AND k.deleted_at IS NULL AND k.phone = ${p.add(i.phone)})`);
      if (i.gstin) conds.push(`EXISTS (SELECT 1 FROM client_registration r WHERE r.client_id = c.id AND r.deleted_at IS NULL AND r.number = upper(${p.add(i.gstin)}))`);
      if (i.name && i.name.trim().length >= 3) conds.push(`similarity(lower(c.name), lower(${p.add(i.name.trim())})) > 0.55`);
      if (!conds.length) return { matches: [], hidden: 0 };
      const visible = clientScopeSql(a, 'clients', 'view', p);
      const rows = (await tx.query(
        `SELECT c.id, c.name, c.pan, c.file_no, (${visible}) AS visible, ${i.name ? `similarity(lower(c.name), lower(${p.add(i.name.trim())}))` : '1'} AS score
         FROM client c WHERE c.deleted_at IS NULL AND (${conds.join(' OR ')}) ${i.excludeId ? `AND c.id <> ${p.add(i.excludeId)}` : ''}
         ORDER BY score DESC LIMIT 20`, p.values)).rows;
      return { matches: rows.filter((r) => r.visible).map((r) => ({ id: r.id, name: r.name, pan: r.pan, fileNo: r.file_no, score: Number(r.score) })), hidden: rows.filter((r) => !r.visible).length };
    });
  }

  /** Merge `sourceId` into `intoId`: children move, tags/groups/staff union, source becomes a tombstone. */
  async merge(a: RequestActor, sourceId: string, intoId: string) {
    if (sourceId === intoId) throw new BadRequestException('Pick two different clients');
    await this.dbs.tenantTx(a.tenantId, async (tx) => {
      const src = await this.loadFor(tx, a, sourceId, 'delete');
      const into = await this.loadFor(tx, a, intoId, 'edit');
      await this.visibility.onChange(tx, a.tenantId, sourceId, visibilityOf(src), visibilityOf(into), { childrenFrom: sourceId });
      // Registrations already on the target (same number) are dropped from the source rather than duplicated.
      await tx.query(`UPDATE client_registration s SET deleted_at = now() WHERE s.client_id = $1 AND s.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM client_registration t WHERE t.client_id = $2 AND t.deleted_at IS NULL AND t.kind = s.kind AND upper(t.number) = upper(s.number))`, [sourceId, intoId]);
      for (const t of ['contact', 'client_registration', 'document', 'vault_secret', 'inward_entry', 'outward_entry']) {
        await tx.query(`UPDATE ${t} SET client_id = $2 WHERE client_id = $1`, [sourceId, intoId]);
      }
      await tx.query(`UPDATE client SET tags = coalesce((SELECT array_agg(DISTINCT t) FROM unnest(tags || $2::text[]) t), '{}'),
        pan = coalesce(pan, $3), email = coalesce(email, $4), phone = coalesce(phone, $5), updated_by = $6 WHERE id = $1`,
        [intoId, src.tags, src.pan, src.email, src.phone, a.userId]);
      await tx.query('UPDATE client SET merged_into = $2, deleted_at = now(), updated_by = $3 WHERE id = $1', [sourceId, intoId, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'client.merged', entity: 'client', entityId: intoId, diff: { from: sourceId, fromName: src.name } });
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: 0 });
  }

  async lookupGstin(gstin: string) {
    const d = await this.gstin.lookup(gstin);
    if (!d) throw new BadRequestException('Invalid GSTIN');
    return { ...d, state: d.state ?? GST_STATES[d.stateCode] };
  }

  // ---- groups & custom fields ----
  /** Groups with the number of clients in each that this actor can see. */
  groups(a: RequestActor) {
    return this.dbs.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const visible = clientScopeSql(a, 'clients', 'view', p);
      return (await tx.query(
        `SELECT g.id, g.name, g.kind, g.parent_id AS "parentId", g.notes,
           (SELECT count(*) FROM client c WHERE g.id = ANY(c.group_ids) AND c.deleted_at IS NULL AND ${visible})::int AS "clientCount"
         FROM client_group g WHERE g.deleted_at IS NULL ORDER BY g.name`, p.values)).rows;
    });
  }

  async createGroup(a: RequestActor, g: { name: string; kind: 'family' | 'group' | 'other'; parentId?: string | null; notes?: string | null }) {
    const id = uuidv7();
    await this.dbs.tenantTx(a.tenantId, async (tx) => {
      if (g.parentId && !(await tx.query('SELECT 1 FROM client_group WHERE id = $1 AND deleted_at IS NULL', [g.parentId])).rowCount) throw new BadRequestException('Unknown parent group');
      await tx.query(`INSERT INTO client_group (id, tenant_id, name, kind, parent_id, notes, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, a.tenantId, g.name, g.kind, g.parentId ?? null, g.notes ?? null, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'client_group.created', entity: 'client_group', entityId: id, diff: g });
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: 0 });
    return { id };
  }

  customFields(a: RequestActor) {
    return this.dbs.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT id, entity, key, label, type, options, required, sort FROM custom_field_def WHERE deleted_at IS NULL ORDER BY sort, label`)).rows);
  }

  async createCustomField(a: RequestActor, f: { key: string; label: string; type: string; options?: string[]; required?: boolean; sort?: number }) {
    const id = uuidv7();
    await this.dbs.tenantTx(a.tenantId, async (tx) => {
      try {
        await tx.query(`INSERT INTO custom_field_def (id, tenant_id, entity, key, label, type, options, required, sort, updated_by) VALUES ($1,$2,'client',$3,$4,$5,$6,$7,$8,$9)`,
          [id, a.tenantId, f.key, f.label, f.type, JSON.stringify(f.options ?? []), f.required ?? false, f.sort ?? 0, a.userId]);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictException('Field key exists'); throw e; }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'custom_field.created', entity: 'custom_field_def', entityId: id, diff: f });
    });
    return { id };
  }

  /** Exposed for import/export and registers. */
  registryHidden(a: RequestActor) { return SYNC_TABLES.client!.hide?.(a) ?? []; }
}
