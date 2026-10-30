import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { can, clientCtx, maskAddress, normalizeEmail, normalizePhone, portalGrantsSchema, portalSettingsSchema, PROFILE_FIELDS, type CommChannel, type PortalGrants } from '@worko/domain';
import type { Readable } from 'node:stream';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params, visibilityOf } from '../clients/scope.js';
import { CommService } from '../comm/comm.service.js';
import { visibleClient } from '../comm/common.js';
import { Clock } from '../common/clock.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { STORAGE, type StorageAdapter } from '../storage/storage.js';
import { SyncService } from '../sync/sync.service.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { loadPortalSettings, portalUrl } from './common.js';

const LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Staff side of the portal: white-label settings, per-client switch, invitations, grants, profile-change approvals, staff replies. */
@Injectable()
export class PortalAdminService {
  constructor(private db: DbService, private audit: AuditService, private comm: CommService, private sync: SyncService, private realtime: RealtimeService,
    private keys: KeyService, private clock: Clock, @Inject(STORAGE) private storage: StorageAdapter) {}

  private rec(tx: Tx, a: RequestActor, action: string, entity: string, entityId: string, diff: Record<string, unknown> = {}) {
    return this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action, entity, entityId, diff });
  }

  // ---------- White-label ----------
  settings(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => loadPortalSettings(tx)); }

  async putSettings(a: RequestActor, body: unknown) {
    requireFirmWide(a, 'settings', 'edit');
    const r = portalSettingsSchema.safeParse(body);
    if (!r.success) throw new BadRequestException({ message: 'Invalid portal settings', issues: r.error.issues });
    return this.db.tenantTx(a.tenantId, async (tx) => {
      if (r.data.logoDocumentId) {
        const d = (await tx.query('SELECT mime, client_id, scan_status FROM document WHERE id = $1 AND deleted_at IS NULL', [r.data.logoDocumentId])).rows[0];
        if (!d || d.client_id || !LOGO_MIME.has(d.mime) || d.scan_status !== 'clean') throw new BadRequestException({ message: 'Logo must be a firm PNG/JPEG/WebP document', code: 'invalid:logoDocumentId' });
      }
      await tx.query(`INSERT INTO portal_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`, [a.tenantId, JSON.stringify(r.data), a.userId]);
      await this.rec(tx, a, 'portal.settings_updated', 'tenant', a.tenantId, { fields: Object.keys(body as object) });
      return r.data;
    });
  }

  /** Public branding by firm slug (for the sign-in page). */
  async branding(firm: string) {
    const t = (await this.db.systemTx((tx) => tx.query('SELECT id, name, slug FROM tenant WHERE slug = $1', [firm.toLowerCase()]))).rows[0];
    if (!t) throw new NotFoundException();
    return this.db.tenantTx(t.id, async (tx) => {
      const s = await loadPortalSettings(tx);
      return { firm: t.slug, displayName: s.displayName ?? t.name, accent: s.accent, logoUrl: s.logoDocumentId ? `/v1/portal/branding/${t.slug}/logo` : null,
        customDomain: s.customDomain, supportEmail: s.supportEmail, supportPhone: s.supportPhone, welcomeText: s.welcomeText };
    });
  }

  async logo(firm: string): Promise<{ mime: string; size: number; stream: Readable }> {
    const t = (await this.db.systemTx((tx) => tx.query('SELECT id FROM tenant WHERE slug = $1', [firm.toLowerCase()]))).rows[0];
    if (!t) throw new NotFoundException();
    const d = await this.db.tenantTx(t.id, async (tx) => {
      const s = await loadPortalSettings(tx);
      if (!s.logoDocumentId) return null;
      return (await tx.query(`SELECT storage_key, mime, size FROM document WHERE id = $1 AND client_id IS NULL AND deleted_at IS NULL AND scan_status = 'clean'`, [s.logoDocumentId])).rows[0] ?? null;
    });
    if (!d || !LOGO_MIME.has(d.mime)) throw new NotFoundException();
    return { mime: d.mime, size: Number(d.size), stream: await this.storage.get(d.storage_key) };
  }

  // ---------- Per-client switch ----------
  async setClientPortal(a: RequestActor, clientId: string, enabled: boolean) {
    const cur = await this.db.tenantTx(a.tenantId, async (tx) => {
      await visibleClient(tx, a, clientId, 'edit', 'clients');
      const r = await this.sync.serverPatch(tx, a, 'client', clientId, { portal_enabled: enabled });
      await this.rec(tx, a, enabled ? 'portal.client_enabled' : 'portal.client_disabled', 'client', clientId);
      return r?.cursor ?? 0;
    });
    this.publish(a.tenantId, cur);
  }
  private publish(tenantId: string, cursor: number) { if (cursor) this.realtime.publish({ type: 'changed', tenantId, cursor }); }

  // ---------- Users, invitations, grants ----------
  users(a: RequestActor, q: { clientId?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      if (q.clientId) await visibleClient(tx, a, q.clientId, 'view', 'clients');
      const rows = (await tx.query(`SELECT u.id, u.name, u.email, u.phone, u.status, u.last_login_at AS "lastLoginAt", a.id AS access_id, a.client_id, c.name AS client_name, a.contact_id, a.grants, a.revoked_at
        FROM portal_user u JOIN portal_access a ON a.portal_user_id = u.id JOIN client c ON c.id = a.client_id
        WHERE c.deleted_at IS NULL AND ${clientScopeSql(a, 'clients', 'view', p)} ${q.clientId ? `AND a.client_id = ${p.add(q.clientId)}` : ''}
        ORDER BY u.name, c.name LIMIT 1000`, p.values)).rows;
      const by = new Map<string, Record<string, unknown> & { access: unknown[] }>();
      for (const r of rows) {
        const u = by.get(r.id) ?? { id: r.id, name: r.name, email: r.email, phone: r.phone, status: r.status, lastLoginAt: r.lastLoginAt, access: [] as unknown[] };
        u.access.push({ id: r.access_id, clientId: r.client_id, clientName: r.client_name, contactId: r.contact_id, grants: portalGrantsSchema.parse(r.grants ?? {}), revokedAt: r.revoked_at });
        by.set(r.id, u);
      }
      return [...by.values()];
    });
  }

  /**
   * Invites a client contact (or links an existing portal user — group companies share one login), with grants, and
   * sends the invitation through the communication pipeline (transactional; consent/opt-out and quiet hours apply).
   */
  async invite(a: RequestActor, b: { clientId: string; contactId: string; grants?: unknown; channel?: CommChannel; send?: boolean; linkExisting?: boolean }) {
    const now = this.clock.now();
    const out = await this.db.tenantTx(a.tenantId, async (tx) => {
      const client = await visibleClient(tx, a, b.clientId, 'edit', 'clients');
      const ct = (await tx.query('SELECT * FROM contact WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL', [b.contactId, b.clientId])).rows[0];
      if (!ct) throw new NotFoundException('Contact not found');
      const email = normalizeEmail(ct.email); const phone = normalizePhone(ct.phone ?? ct.whatsapp);
      if (!email && !phone) throw new BadRequestException({ message: 'The contact needs an email or a mobile number', code: 'no_address' });
      const settings = await loadPortalSettings(tx);
      const g = portalGrantsSchema.safeParse(b.grants ?? settings.defaultGrants);
      if (!g.success) throw new BadRequestException({ message: 'Invalid grants', issues: g.error.issues });
      const found = (await tx.query('SELECT * FROM portal_user WHERE ($1::text IS NOT NULL AND email = $1) OR ($2::text IS NOT NULL AND phone = $2)', [email, phone])).rows;
      if (found.length > 1) throw new ConflictException({ message: 'Email and mobile belong to two different portal users', code: 'identity_conflict' });
      let user = found[0];
      if (user?.status === 'disabled') throw new ConflictException({ message: 'This portal user is disabled', code: 'portal_user_disabled' });
      // Matching by email OR mobile could merge two people: staff must confirm explicitly, and identifiers are never added silently (D139).
      if (user && !b.linkExisting) {
        throw new ConflictException({ message: 'A portal login already uses this email or mobile', code: 'existing_portal_user',
          match: { email: user.email && user.email === email ? maskAddress(user.email) : null, phone: user.phone && user.phone === phone ? maskAddress(user.phone) : null } });
      }
      if (!user) {
        user = { id: uuidv7(), status: 'invited' };
        await tx.query('INSERT INTO portal_user (id, tenant_id, name, email, phone, invited_by) VALUES ($1,$2,$3,$4,$5,$6)', [user.id, a.tenantId, ct.name, email, phone, a.userId]);
      }
      const accessId = (await tx.query(`INSERT INTO portal_access (id, tenant_id, portal_user_id, client_id, contact_id, grants, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (portal_user_id, client_id) DO UPDATE SET contact_id = EXCLUDED.contact_id, grants = EXCLUDED.grants, revoked_at = NULL, revoked_by = NULL, updated_at = now()
        RETURNING id`, [uuidv7(), a.tenantId, user.id, b.clientId, ct.id, JSON.stringify(g.data), a.userId])).rows[0].id as string;
      const wasEnabled = !!client.portal_enabled;
      const enabledCur = wasEnabled ? 0 : (await this.sync.serverPatch(tx, a, 'client', b.clientId, { portal_enabled: true }))?.cursor ?? 0;
      await this.rec(tx, a, 'portal.invited', 'portal_access', accessId, { clientId: b.clientId, contactId: ct.id, portalUserId: user.id, newUser: user.status === 'invited' && found.length === 0, portalEnabled: !wasEnabled, grants: summary(g.data) });
      let invite: { status: string; reason?: string; messageId?: string } = { status: 'not_sent' };
      if (b.send !== false) {
        const channel: CommChannel = b.channel ?? (email ? 'email' : 'sms');
        const address = channel === 'email' ? email : normalizePhone(channel === 'whatsapp' ? ct.whatsapp ?? ct.phone : ct.phone);
        if (!address) invite = { status: 'refused', reason: 'no_address' };
        else {
          const t = (await tx.query('SELECT slug, name FROM tenant WHERE id = current_tenant()')).rows[0];
          const brand = settings.displayName ?? t.name;
          const q = await this.comm.queueTx(tx, a.tenantId, { clientId: b.clientId, contactId: ct.id, channel, address, category: 'transactional', subject: channel === 'email' ? `${brand} client portal` : null,
            text: `Hello ${ct.name}, ${brand} has given you access to its client portal for ${client.name}. Sign in at ${portalUrl(t.slug)} with this ${channel === 'email' ? 'email address' : 'mobile number'} — we will send you a one-time code.`,
            createdBy: a.userId, now, meta: { portalInvite: accessId }, format: 'text' });
          invite = 'error' in q ? { status: 'refused', reason: q.error } : { status: 'queued', messageId: q.id };
        }
      }
      return { portalUserId: user.id as string, accessId, invite, enabledCur };
    });
    this.publish(a.tenantId, out.enabledCur);
    if (out.invite.messageId) out.invite.status = String(await this.comm.deliverNow(a.tenantId, out.invite.messageId, now));
    return { portalUserId: out.portalUserId, accessId: out.accessId, invite: out.invite };
  }

  private async accessRow(tx: Tx, a: RequestActor, id: string) {
    const r = (await tx.query('SELECT * FROM portal_access WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new NotFoundException();
    await visibleClient(tx, a, r.client_id, 'edit', 'clients');
    return r;
  }

  async updateAccess(a: RequestActor, id: string, b: { grants?: unknown; revoked?: boolean }) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.accessRow(tx, a, id);
      let grants: PortalGrants | undefined;
      if (b.grants !== undefined) {
        const g = portalGrantsSchema.safeParse(b.grants);
        if (!g.success) throw new BadRequestException({ message: 'Invalid grants', issues: g.error.issues });
        grants = g.data;
      }
      await tx.query(`UPDATE portal_access SET grants = COALESCE($2, grants), revoked_at = CASE WHEN $3::boolean IS NULL THEN revoked_at WHEN $3 THEN now() ELSE NULL END,
        revoked_by = CASE WHEN $3 THEN $4::uuid ELSE revoked_by END, updated_at = now() WHERE id = $1`, [id, grants ? JSON.stringify(grants) : null, b.revoked ?? null, a.userId]);
      // Losing the last client ends every session of that person.
      if (b.revoked && !(await tx.query('SELECT 1 FROM portal_access WHERE portal_user_id = $1 AND revoked_at IS NULL', [r.portal_user_id])).rowCount) {
        await tx.query('UPDATE portal_session SET revoked_at = now() WHERE portal_user_id = $1 AND revoked_at IS NULL', [r.portal_user_id]);
      }
      await this.rec(tx, a, b.revoked ? 'portal.access_revoked' : 'portal.access_updated', 'portal_access', id, { clientId: r.client_id, grants: grants ? summary(grants) : undefined, revoked: b.revoked });
    });
  }

  async updateUser(a: RequestActor, id: string, b: { status: 'active' | 'disabled' }) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const clients = (await tx.query('SELECT c.* FROM portal_access x JOIN client c ON c.id = x.client_id WHERE x.portal_user_id = $1', [id])).rows;
      if (!clients.length || !clients.some((c) => can(a, 'clients', 'view', clientCtx(visibilityOf(c))))) throw new NotFoundException();
      // Disabling cuts access to every client, so it needs edit on all of them.
      if (!clients.every((c) => can(a, 'clients', 'edit', clientCtx(visibilityOf(c))))) throw new ForbiddenException();
      await tx.query(`UPDATE portal_user SET status = CASE WHEN $2 = 'disabled' THEN 'disabled' WHEN last_login_at IS NULL THEN 'invited' ELSE 'active' END, updated_at = now(), version = version + 1 WHERE id = $1`, [id, b.status]);
      if (b.status === 'disabled') await tx.query('UPDATE portal_session SET revoked_at = now() WHERE portal_user_id = $1 AND revoked_at IS NULL', [id]);
      await this.rec(tx, a, `portal.user_${b.status === 'disabled' ? 'disabled' : 'enabled'}`, 'portal_user', id);
    });
  }

  // ---------- Profile-change requests ----------
  profileRequests(a: RequestActor, q: { status?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([q.status ?? 'pending']);
      const rows = (await tx.query(`SELECT r.*, c.name AS client_name, u.name AS user_name FROM portal_profile_request r JOIN client c ON c.id = r.client_id JOIN portal_user u ON u.id = r.portal_user_id
        WHERE r.status = $1 AND ${clientScopeSql(a, 'clients', 'view', p)} ORDER BY r.created_at DESC LIMIT 200`, p.values)).rows;
      const out = [];
      for (const r of rows) {
        out.push({ id: r.id, clientId: r.client_id, clientName: r.client_name, contactId: r.contact_id, portalUserId: r.portal_user_id, requestedBy: r.user_name, fields: r.fields, status: r.status,
          changes: JSON.parse(await this.keys.decrypt(tx, a.tenantId, r.changes_enc, `portal_profile_request:${r.id}:changes`)), createdAt: r.created_at, reason: r.reason });
      }
      return out;
    });
  }

  async decideProfileRequest(a: RequestActor, id: string, b: { approve: boolean; reason?: string | null }) {
    const cur = await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = (await tx.query('SELECT * FROM portal_profile_request WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundException();
      await visibleClient(tx, a, r.client_id, 'edit', 'clients');
      if (r.status !== 'pending') throw new ConflictException({ message: 'Already decided', code: 'already_decided' });
      let cursor = 0;
      if (b.approve) {
        const changes = JSON.parse(await this.keys.decrypt(tx, a.tenantId, r.changes_enc, `portal_profile_request:${id}:changes`)) as Record<string, string | null>;
        const patch: Record<string, unknown> = {};
        for (const f of PROFILE_FIELDS) if (f in changes) patch[f] = f === 'email' ? normalizeEmail(changes[f]) : f === 'phone' || f === 'whatsapp' ? normalizePhone(changes[f]) : changes[f];
        if (r.contact_id) cursor = (await this.sync.serverPatch(tx, a, 'contact', r.contact_id, patch))?.cursor ?? 0;
        // Keep the sign-in identity in step with the contact.
        if ('email' in patch || 'phone' in patch) {
          try {
            await tx.query('SAVEPOINT pu');
            await tx.query(`UPDATE portal_user SET email = CASE WHEN $2 THEN $3 ELSE email END, phone = CASE WHEN $4 THEN $5 ELSE phone END, updated_at = now() WHERE id = $1`,
              [r.portal_user_id, 'email' in patch && !!patch.email, patch.email ?? null, 'phone' in patch && !!patch.phone, patch.phone ?? null]);
          } catch { await tx.query('ROLLBACK TO SAVEPOINT pu'); throw new ConflictException({ message: 'That email/mobile is used by another portal user', code: 'identity_conflict' }); }
        }
      }
      await tx.query('UPDATE portal_profile_request SET status = $2, reason = $3, decided_by = $4, decided_at = now() WHERE id = $1', [id, b.approve ? 'approved' : 'rejected', b.reason ?? null, a.userId]);
      await this.rec(tx, a, b.approve ? 'portal.profile_change_approved' : 'portal.profile_change_rejected', 'portal_profile_request', id, { clientId: r.client_id, fields: r.fields });
      return cursor;
    });
    if (cur) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: cur });
  }

  // ---------- Staff side of the portal thread ----------
  thread(a: RequestActor, clientId: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await visibleClient(tx, a, clientId, 'view');
      return (await tx.query(`SELECT m.id, m.direction, m.subject, m.body, m.occurred_at AS "at", m.document_ids AS "documentIds", m.created_by AS "staffId", m.portal_user_id AS "portalUserId", m.meta
        FROM comm_message m WHERE m.client_id = $1 AND m.channel = 'portal' AND m.deleted_at IS NULL ORDER BY m.occurred_at, m.id LIMIT 500`, [clientId])).rows;
    });
  }

  async reply(a: RequestActor, clientId: string, body: string) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      await visibleClient(tx, a, clientId, 'create');
      const id = uuidv7();
      await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, direction, channel, body, status, created_by, occurred_at, device_id) VALUES ($1,$2,$3,'out','portal',$4,'sent',$5,$6,$7)`,
        [id, a.tenantId, clientId, body, a.userId, this.clock.now(), a.deviceId]);
      await this.rec(tx, a, 'portal.message_replied', 'comm_message', id, { clientId, length: body.length });
      return { id, cursor: Number((await tx.query('SELECT sync_cursor FROM comm_message WHERE id = $1', [id])).rows[0].sync_cursor) };
    });
    this.publish(a.tenantId, r.cursor); // after commit
    return { id: r.id };
  }
}

/** Grants in audit diffs: which areas are on, never document names. */
const summary = (g: PortalGrants) => ({ ...g, documents: { enabled: g.documents.enabled, categories: g.documents.categories.length, fys: g.documents.fys.length } });
