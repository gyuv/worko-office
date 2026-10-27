import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { can, clientCtx, effectiveScope, type Action } from '@worko/domain';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../auth/crypto.js';
import { clientScopeSql, Params } from '../clients/scope.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { STORAGE, VIRUS_SCANNER, type StorageAdapter, type VirusScanner } from '../storage/storage.js';
import { visibilityOf } from '../sync/registry.js';
import { SyncService } from '../sync/sync.service.js';

export const MAX_UPLOAD = 25 * 1024 * 1024;
/** Document types we accept. No executables, scripts or HTML (they could run in our origin when previewed). */
const ALLOWED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff', 'text/plain', 'text/csv', 'application/json', 'application/xml', 'text/xml',
  'application/zip', 'application/x-zip-compressed', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream',
]);
const BLOCKED_EXT = /\.(exe|bat|cmd|com|msi|scr|js|mjs|vbs|ps1|sh|jar|html?|svg|xhtml|php|dll)$/i;

export type UploadMeta = { clientId?: string | null; fy?: string | null; category?: string; name?: string; tags?: string[]; permanent?: boolean; expiresOn?: string | null; documentId?: string; note?: string };

/** Firm documents (not tied to a client) need firm-wide scope for the action. */
const firmWide = (a: RequestActor, action: Action) => effectiveScope(a, 'documents', action)?.scope === 'all';

const signKey = () => createHash('sha256').update(`download:${process.env.JWT_SIGNING_KEY ?? 'worko-dev-only-signing-key'}`).digest();

@Injectable()
export class DocumentsService {
  constructor(
    private db: DbService, private audit: AuditService, private realtime: RealtimeService, private sync: SyncService,
    @Inject(STORAGE) private storage: StorageAdapter, @Inject(VIRUS_SCANNER) private scanner: VirusScanner,
  ) {}

  /** Permission check for a document (or a would-be document) of `clientId`; firm documents need firm-wide scope. */
  private async check(tx: Tx, a: RequestActor, clientId: string | null, action: Action) {
    if (!clientId) {
      if (!firmWide(a, action)) throw new NotFoundException();
      return;
    }
    const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0];
    const ctx = c && clientCtx(visibilityOf(c));
    if (!c || !can(a, 'clients', 'view', ctx) || !can(a, 'documents', 'view', ctx)) throw new NotFoundException('Client not found');
    if (!can(a, 'documents', action, ctx)) throw new ForbiddenException();
  }

  private async loadDoc(tx: Tx, a: RequestActor, id: string, action: Action, includeTrashed = false) {
    const d = (await tx.query(`SELECT * FROM document WHERE id = $1 ${includeTrashed ? '' : 'AND deleted_at IS NULL'}`, [id])).rows[0];
    if (!d) throw new NotFoundException();
    await this.check(tx, a, d.client_id, action);
    return d;
  }

  async upload(a: RequestActor, file: { buffer: Buffer; mimetype: string; originalname: string; size: number }, m: UploadMeta, ip: string | null) {
    if (!file?.buffer?.length) throw new BadRequestException('Empty file');
    if (file.size > MAX_UPLOAD) throw new BadRequestException('File too large (25 MB max)');
    const name = (m.name ?? file.originalname).trim().slice(0, 300);
    if (BLOCKED_EXT.test(name) || !ALLOWED_MIME.has(file.mimetype)) throw new BadRequestException('This file type is not allowed');
    const sha = createHash('sha256').update(file.buffer).digest('hex');
    if ((await this.scanner.scan(file.buffer)) === 'infected') {
      await this.db.tenantTx(a.tenantId, (tx) => this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'document.blocked_malware', entity: 'document', diff: { name, sha256: sha }, ip }));
      throw new UnprocessableEntityException('The file failed the virus scan and was not stored');
    }
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      let id = m.documentId; let version = 1; let clientId = m.clientId ?? null;
      if (id) {
        const d = await this.loadDoc(tx, a, id, 'edit');
        if (d.legal_hold) throw new ForbiddenException('Document is under legal hold');
        version = d.current_version + 1; clientId = d.client_id;
      } else {
        await this.check(tx, a, clientId, 'create');
        id = uuidv7();
      }
      const key = `t/${a.tenantId}/d/${id}/v${version}`;
      await this.storage.put(key, file.buffer, file.mimetype);
      if (version === 1) {
        await tx.query(`INSERT INTO document (id, tenant_id, client_id, fy, category, name, mime, size, sha256, storage_key, tags, permanent, expires_on, uploaded_by, updated_by, field_versions)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,'{}')`,
          [id, a.tenantId, clientId, m.fy ?? null, m.category ?? 'General', name, file.mimetype, file.size, sha, key, m.tags ?? [], m.permanent ?? false, m.expiresOn ?? null, a.userId]);
      } else {
        await tx.query(`UPDATE document SET current_version = $2, storage_key = $3, size = $4, sha256 = $5, mime = $6, updated_by = $7 WHERE id = $1`, [id, version, key, file.size, sha, file.mimetype, a.userId]);
      }
      await tx.query(`INSERT INTO document_version (id, tenant_id, document_id, version, storage_key, size, sha256, mime, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuidv7(), a.tenantId, id, version, key, file.size, sha, file.mimetype, m.note ?? null, a.userId]);
      await this.log(tx, a, id, 'upload', ip);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: version === 1 ? 'document.uploaded' : 'document.new_version', entity: 'document', entityId: id, diff: { name, size: file.size, sha256: sha, version } });
      return { id, version };
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: 0 });
    return r;
  }

  private log(tx: Tx, a: RequestActor | null, documentId: string, action: string, ip: string | null, shareLinkId: string | null = null,
    tenantId = a?.tenantId, userId: string | null = a?.userId ?? null) {
    return tx.query('INSERT INTO document_access_log (tenant_id, document_id, user_id, share_link_id, action, ip) VALUES ($1,$2,$3,$4,$5,$6)',
      [tenantId, documentId, userId, shareLinkId, action, ip]);
  }

  list(a: RequestActor, q: { clientId?: string; fy?: string; category?: string; q?: string; trashed?: boolean; limit: number; offset: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = [q.trashed ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL',
        `(d.client_id IS NULL AND ${firmWide(a, 'view') ? 'TRUE' : 'FALSE'}
          OR EXISTS (SELECT 1 FROM client c WHERE c.id = d.client_id AND c.deleted_at IS NULL AND ${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'documents', 'view', p)}))`];
      if (q.clientId) where.push(`d.client_id = ${p.add(q.clientId)}`);
      if (q.fy) where.push(`d.fy = ${p.add(q.fy)}`);
      if (q.category) where.push(`d.category = ${p.add(q.category)}`);
      if (q.q) where.push(`to_tsvector('simple', document_search_text(d.name, d.category, d.tags, d.extracted_text)) @@ plainto_tsquery('simple', ${p.add(q.q)})`);
      const rows = (await tx.query(
        `SELECT d.id, d.client_id AS "clientId", c.name AS "clientName", d.fy, d.category, d.name, d.mime, d.size, d.current_version AS "currentVersion",
                d.tags, d.permanent, d.expires_on AS "expiresOn", d.legal_hold AS "legalHold", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
                d.deleted_at AS "deletedAt", count(*) OVER () AS total
         FROM document d LEFT JOIN client c ON c.id = d.client_id WHERE ${where.join(' AND ')}
         ORDER BY d.updated_at DESC LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, ...r }) => ({ ...r, size: Number(r.size) })) };
    });
  }

  /** Folder tree for one client: FY → category → count. */
  tree(a: RequestActor, clientId: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.check(tx, a, clientId, 'view');
      return (await tx.query(`SELECT coalesce(fy, 'Permanent') AS fy, category, count(*)::int AS count FROM document WHERE client_id = $1 AND deleted_at IS NULL
        GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [clientId])).rows;
    });
  }

  versions(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadDoc(tx, a, id, 'view');
      return (await tx.query(`SELECT version, size, sha256, mime, note, uploaded_by AS "uploadedBy", created_at AS "createdAt" FROM document_version WHERE document_id = $1 ORDER BY version DESC`, [id])).rows
        .map((r) => ({ ...r, size: Number(r.size) }));
    });
  }

  async updateMeta(a: RequestActor, id: string, m: { name?: string; category?: string; fy?: string | null; tags?: string[]; permanent?: boolean; expiresOn?: string | null; legalHold?: boolean }) {
    const res = await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadDoc(tx, a, id, 'edit');
      const patch: Record<string, unknown> = {};
      if (m.name !== undefined) patch.name = m.name;
      if (m.category !== undefined) patch.category = m.category;
      if (m.fy !== undefined) patch.fy = m.fy;
      if (m.tags !== undefined) patch.tags = m.tags;
      if (m.permanent !== undefined) patch.permanent = m.permanent;
      if (m.expiresOn !== undefined) patch.expires_on = m.expiresOn;
      const r = await this.sync.serverPatch(tx, a, 'document', id, patch);
      if (m.legalHold !== undefined) {
        if (effectiveScope(a, 'documents', 'approve')?.scope !== 'all') throw new ForbiddenException('Only firm-wide approvers can set legal hold');
        await tx.query('UPDATE document SET legal_hold = $2 WHERE id = $1', [id, m.legalHold]);
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'document.updated', entity: 'document', entityId: id, diff: m });
      return r;
    });
    if (res) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: res.cursor });
  }

  async trash(a: RequestActor, id: string, restore: boolean) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const d = await this.loadDoc(tx, a, id, 'delete', restore);
      if (!restore && d.legal_hold) throw new ForbiddenException('Document is under legal hold');
      await tx.query(`UPDATE document SET deleted_at = ${restore ? 'NULL' : 'now()'}, updated_by = $2 WHERE id = $1`, [id, a.userId]);
      await this.log(tx, a, id, restore ? 'restore' : 'delete', null);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: restore ? 'document.restored' : 'document.trashed', entity: 'document', entityId: id });
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: 0 });
  }

  // ---- downloads ----
  /** A 2-minute signed URL (for <a href> / previews where a bearer header can't be sent). */
  async downloadUrl(a: RequestActor, id: string, version?: number) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const d = await this.loadDoc(tx, a, id, 'view');
      const v = version ?? d.current_version;
      const payload = Buffer.from(JSON.stringify({ t: a.tenantId, d: id, v, u: a.userId, e: Date.now() + 120_000 })).toString('base64url');
      const sig = createHmac('sha256', signKey()).update(payload).digest('base64url');
      return { url: `/v1/files/${payload}.${sig}`, expiresInSeconds: 120 };
    });
  }

  /** Validates a signed token; returns what to stream. Logs the download against the user who requested it. */
  async openSigned(token: string, ip: string | null) {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) throw new NotFoundException();
    const expect = createHmac('sha256', signKey()).update(payload).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw new NotFoundException();
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t: string; d: string; v: number; u: string; e: number };
    if (p.e < Date.now()) throw new NotFoundException('Link expired');
    return this.db.tenantTx(p.t, async (tx) => {
      const v = (await tx.query(`SELECT d.name, v.storage_key, v.mime, v.size FROM document d JOIN document_version v ON v.document_id = d.id AND v.version = $2 WHERE d.id = $1 AND d.deleted_at IS NULL`, [p.d, p.v])).rows[0];
      if (!v) throw new NotFoundException();
      await this.log(tx, null, p.d, 'download', ip, null, p.t, p.u);
      return { name: v.name as string, mime: v.mime as string, size: Number(v.size), stream: await this.storage.get(v.storage_key) };
    });
  }

  // ---- share links ----
  async createShare(a: RequestActor, id: string, s: { expiresInHours: number; password?: string; maxDownloads?: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadDoc(tx, a, id, 'export');
      const token = `${a.tenantId}.${randomToken(24)}`;
      const linkId = uuidv7();
      await tx.query(`INSERT INTO share_link (id, tenant_id, document_id, token_hash, password_hash, expires_at, max_downloads, created_by)
        VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), $7, $8)`,
        [linkId, a.tenantId, id, sha256(token), s.password ? await hashPassword(s.password) : null, s.expiresInHours, s.maxDownloads ?? null, a.userId]);
      await this.log(tx, a, id, 'share', null, linkId);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'document.shared', entity: 'document', entityId: id, diff: { linkId, expiresInHours: s.expiresInHours, password: !!s.password, maxDownloads: s.maxDownloads ?? null } });
      return { id: linkId, url: `/v1/share/${token}`, passwordRequired: !!s.password };
    });
  }

  async revokeShare(a: RequestActor, linkId: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const l = (await tx.query('SELECT document_id FROM share_link WHERE id = $1', [linkId])).rows[0];
      if (!l) throw new NotFoundException();
      await this.loadDoc(tx, a, l.document_id, 'export', true);
      await tx.query('UPDATE share_link SET revoked_at = now() WHERE id = $1', [linkId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'document.share_revoked', entity: 'document', entityId: l.document_id, diff: { linkId } });
    });
  }

  /** Public share download. Uniform 404 for bad/expired/revoked/exhausted links and wrong passwords. */
  async openShare(token: string, password: string | undefined, ip: string | null) {
    const tenantId = token.split('.')[0] ?? '';
    if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new NotFoundException();
    const r = await this.db.tenantTx(tenantId, async (tx) => {
      const l = (await tx.query(`SELECT s.*, d.name, d.storage_key, d.mime, d.size FROM share_link s JOIN document d ON d.id = s.document_id AND d.deleted_at IS NULL
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() FOR UPDATE OF s`, [sha256(token)])).rows[0];
      if (!l || (l.max_downloads !== null && l.downloads >= l.max_downloads)) return { error: 'gone' as const };
      if (l.password_hash && (!password || !(await verifyPassword(password, l.password_hash)))) return { error: 'password' as const };
      await tx.query('UPDATE share_link SET downloads = downloads + 1 WHERE id = $1', [l.id]);
      await this.log(tx, null, l.document_id, 'share_download', ip, l.id, tenantId);
      return { name: l.name as string, mime: l.mime as string, size: Number(l.size), key: l.storage_key as string };
    });
    if ('error' in r) throw new NotFoundException(r.error === 'password' ? { code: 'PASSWORD_REQUIRED', message: 'Password required' } : 'This link is no longer available');
    return { ...r, stream: await this.storage.get(r.key) };
  }

  accessLog(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadDoc(tx, a, id, 'view', true);
      return (await tx.query(`SELECT l.at, l.action, l.ip, l.share_link_id AS "shareLinkId", u.name AS "userName" FROM document_access_log l
        LEFT JOIN app_user u ON u.id = l.user_id WHERE l.document_id = $1 ORDER BY l.id DESC LIMIT 200`, [id])).rows;
    });
  }

  shares(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadDoc(tx, a, id, 'view');
      return (await tx.query(`SELECT id, expires_at AS "expiresAt", max_downloads AS "maxDownloads", downloads, password_hash IS NOT NULL AS "passwordProtected",
        revoked_at AS "revokedAt", created_at AS "createdAt" FROM share_link WHERE document_id = $1 ORDER BY created_at DESC`, [id])).rows;
    });
  }
}
