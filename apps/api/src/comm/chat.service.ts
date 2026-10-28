import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { can, clientCtx, effectiveScope } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import { Params, visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { visibleClient } from './common.js';
import { memberSql } from './sync-rules.js';

type ChannelIn = { kind: 'team' | 'branch' | 'direct' | 'client' | 'group'; name?: string; teamId?: string; branchId?: string; clientId?: string; memberIds?: string[] };
const msgOut = (r: Record<string, unknown>) => ({ id: r.id, channelId: r.channel_id, authorId: r.author_id, body: r.body, mentions: r.mentions, attachmentDocIds: r.attachment_doc_ids,
  editedAt: r.edited_at, createdAt: r.created_at, deleted: !!r.deleted_at, version: r.version });

/** Team chat REST surface (D106). Messages go through the sync registry path (same validation as device pushes). */
@Injectable()
export class ChatService {
  constructor(private db: DbService, private audit: AuditService, private sync: SyncService, private realtime: RealtimeService, private clock: Clock) {}

  private staff(a: RequestActor) { if (!a.roles.length && !a.superAdmin) throw new ForbiddenException(); }
  private firmWide = (a: RequestActor) => !!a.superAdmin || effectiveScope(a, 'communication', 'edit')?.scope === 'all';
  private async members(tx: Tx, channelId: string): Promise<string[]> {
    return (await tx.query('SELECT user_id FROM chat_member WHERE channel_id = $1 AND deleted_at IS NULL', [channelId])).rows.map((r) => r.user_id);
  }
  private publish(tenantId: string, cursor: number, userIds?: string[]) { if (cursor) this.realtime.publish({ type: 'changed', tenantId, cursor, userIds }); }
  /** Channel the actor is a member of (else 404). */
  private async channel(tx: Tx, a: RequestActor, id: string) {
    const p = new Params([id]);
    const c = (await tx.query(`SELECT * FROM chat_channel x WHERE x.id = $1 AND x.deleted_at IS NULL AND ${memberSql(a, p, 'x.id')}`, p.values)).rows[0];
    if (!c) throw new NotFoundException();
    return c;
  }
  /** Each member of a client channel must be able to see the client for communication (D106). */
  private async canSeeClient(tx: Tx, a: RequestActor, userId: string, client: Record<string, unknown>) {
    const u = (await tx.query('SELECT branch_id FROM app_user WHERE id = $1', [userId])).rows[0];
    const actor = { userId, tenantId: a.tenantId, sessionId: '', deviceId: '', branchId: u?.branch_id ?? null, teamIds: await loadTeamIds(tx, userId), roles: await loadUserRoles(tx, userId) };
    const ctx = clientCtx(visibilityOf(client));
    return can(actor, 'clients', 'view', ctx) && can(actor, 'communication', 'view', ctx);
  }
  private async staffIds(tx: Tx, ids: string[]) {
    const ok = (await tx.query(`SELECT id FROM app_user WHERE id = ANY($1) AND status = 'active' AND kind = 'staff' AND deleted_at IS NULL`, [ids])).rows.map((r) => r.id as string);
    if (ok.length !== new Set(ids).size) throw new BadRequestException({ message: 'Unknown or inactive member', code: 'invalid_member' });
    return ok;
  }

  async list(a: RequestActor) {
    this.staff(a);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([a.userId]);
      return (await tx.query(`SELECT x.id, x.kind, x.name, x.client_id AS "clientId", x.team_id AS "teamId", x.branch_id AS "branchId", x.archived, m.last_read_message_id AS "lastReadMessageId", m.muted,
          (SELECT count(*)::int FROM chat_message cm WHERE cm.channel_id = x.id AND cm.deleted_at IS NULL AND cm.author_id <> $1
             AND cm.created_at > COALESCE((SELECT created_at FROM chat_message lr WHERE lr.id = m.last_read_message_id), '-infinity')) AS unread,
          (SELECT max(created_at) FROM chat_message cm WHERE cm.channel_id = x.id AND cm.deleted_at IS NULL) AS "lastMessageAt"
        FROM chat_channel x JOIN chat_member m ON m.channel_id = x.id AND m.user_id = $1 AND m.deleted_at IS NULL
        WHERE x.deleted_at IS NULL AND ${memberSql(a, p, 'x.id')} ORDER BY "lastMessageAt" DESC NULLS LAST, x.name`, p.values)).rows;
    });
  }

  async create(a: RequestActor, b: ChannelIn) {
    this.staff(a);
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      let members: string[]; let name = b.name?.trim() ?? ''; let directKey: string | null = null; let client: Record<string, unknown> | null = null;
      switch (b.kind) {
        case 'team': {
          const t = b.teamId && (await tx.query('SELECT * FROM team WHERE id = $1 AND deleted_at IS NULL', [b.teamId])).rows[0];
          if (!t) throw new BadRequestException({ message: 'Team required', code: 'invalid_team' });
          if (!a.teamIds.includes(t.id) && !this.firmWide(a)) throw new ForbiddenException('Not in that team');
          members = (await tx.query(`SELECT user_id FROM team_member WHERE team_id = $1 UNION SELECT lead_user_id FROM team WHERE id = $1 AND lead_user_id IS NOT NULL`, [t.id])).rows.map((x) => x.user_id);
          name ||= t.name; break;
        }
        case 'branch': {
          const branch = b.branchId ?? a.branchId;
          const br = branch && (await tx.query('SELECT * FROM branch WHERE id = $1 AND deleted_at IS NULL', [branch])).rows[0];
          if (!br) throw new BadRequestException({ message: 'Branch required', code: 'invalid_branch' });
          if (br.id !== a.branchId && !this.firmWide(a)) throw new ForbiddenException('Not in that branch');
          members = (await tx.query(`SELECT id AS user_id FROM app_user WHERE branch_id = $1 AND status = 'active' AND kind = 'staff' AND deleted_at IS NULL`, [br.id])).rows.map((x) => x.user_id);
          name ||= br.name; break;
        }
        case 'direct': {
          const other = (b.memberIds ?? []).filter((u) => u !== a.userId);
          if (other.length !== 1) throw new BadRequestException({ message: 'A direct chat has exactly one other member', code: 'invalid_member' });
          await this.staffIds(tx, other);
          directKey = [a.userId, other[0]!].sort().join(':');
          const existing = (await tx.query('SELECT id FROM chat_channel WHERE direct_key = $1 AND deleted_at IS NULL', [directKey])).rows[0];
          if (existing) return { id: existing.id as string, created: false, cursor: 0, members: [] };
          members = [other[0]!];
          name = 'Direct'; break;
        }
        case 'client': {
          client = await visibleClient(tx, a, b.clientId ?? '', 'create');
          members = await this.staffIds(tx, (b.memberIds ?? []).filter((u) => u !== a.userId));
          for (const u of members) if (!(await this.canSeeClient(tx, a, u, client))) throw new BadRequestException({ message: 'A member cannot see this client', code: 'member_cannot_view_client' });
          name ||= String(client.name); break;
        }
        default: {
          if (!name) throw new BadRequestException({ message: 'Name required', code: 'name_required' });
          members = await this.staffIds(tx, (b.memberIds ?? []).filter((u) => u !== a.userId));
        }
      }
      const id = uuidv7();
      await tx.query(`INSERT INTO chat_channel (id, tenant_id, kind, name, team_id, branch_id, client_id, direct_key, created_by, updated_by, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'server')`,
        [id, a.tenantId, b.kind, name.slice(0, 200), b.kind === 'team' ? b.teamId : null, b.kind === 'branch' ? (b.branchId ?? a.branchId) : null, client?.id ?? null, directKey, a.userId]);
      let cursor = 0;
      for (const u of new Set([a.userId, ...members])) {
        const m = await tx.query(`INSERT INTO chat_member (id, tenant_id, channel_id, user_id, role, joined_at, device_id) VALUES ($1,$2,$3,$4,$5,$6,'server') RETURNING sync_cursor`,
          [uuidv7(), a.tenantId, id, u, u === a.userId ? 'owner' : 'member', this.clock.now()]);
        cursor = Math.max(cursor, Number(m.rows[0].sync_cursor));
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'chat.channel_created', entity: 'chat_channel', entityId: id, diff: { kind: b.kind, members: members.length + 1, clientId: client?.id ?? null } });
      return { id, created: true, cursor, members: [a.userId, ...members] };
    });
    this.publish(a.tenantId, r.cursor, r.members);
    return { id: r.id, created: r.created };
  }

  async changeMembers(a: RequestActor, id: string, b: { add?: string[]; remove?: string[] }) {
    this.staff(a);
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.channel(tx, a, id);
      const me = (await tx.query('SELECT role FROM chat_member WHERE channel_id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, a.userId])).rows[0];
      if (me?.role !== 'owner' && !this.firmWide(a)) throw new ForbiddenException('Only the channel owner changes members');
      if (c.kind === 'direct') throw new ConflictException({ message: 'Direct chats have fixed members', code: 'direct_fixed' });
      const add = await this.staffIds(tx, b.add ?? []);
      const client = c.client_id ? (await tx.query('SELECT * FROM client WHERE id = $1', [c.client_id])).rows[0] : null;
      if (client) for (const u of add) if (!(await this.canSeeClient(tx, a, u, client))) throw new BadRequestException({ message: 'A member cannot see this client', code: 'member_cannot_view_client' });
      let cursor = 0;
      for (const u of add) {
        const m = await tx.query(`INSERT INTO chat_member (id, tenant_id, channel_id, user_id, joined_at, device_id) VALUES ($1,$2,$3,$4,$5,'server')
          ON CONFLICT (channel_id, user_id) DO UPDATE SET deleted_at = NULL, joined_at = EXCLUDED.joined_at RETURNING sync_cursor`, [uuidv7(), a.tenantId, id, u, this.clock.now()]);
        cursor = Math.max(cursor, Number(m.rows[0].sync_cursor));
      }
      const remove = (b.remove ?? []).filter((u) => u !== a.userId || me?.role !== 'owner');
      const gone = (await tx.query(`UPDATE chat_member SET deleted_at = now() WHERE channel_id = $1 AND user_id = ANY($2) AND deleted_at IS NULL RETURNING user_id, sync_cursor`, [id, remove])).rows;
      if (gone.length) {
        const users = gone.map((g) => g.user_id);
        cursor = Math.max(cursor, ...gone.map((g) => Number(g.sync_cursor)));
        // Removed members' devices drop the channel, its members and its messages (tombstones via sync_revocation).
        const rv = await tx.query(`INSERT INTO sync_revocation (tenant_id, table_name, row_id, user_ids, sync_cursor)
          SELECT $1, t.table_name, t.row_id, $3, nextval('sync_cursor_seq') FROM (
            SELECT 'chat_channel' AS table_name, $2::uuid AS row_id
            UNION ALL SELECT 'chat_member', id FROM chat_member WHERE channel_id = $2
            UNION ALL SELECT 'chat_message', id FROM chat_message WHERE channel_id = $2) t RETURNING sync_cursor`, [a.tenantId, id, users]);
        cursor = Math.max(cursor, ...rv.rows.map((x) => Number(x.sync_cursor)));
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'chat.members_changed', entity: 'chat_channel', entityId: id, diff: { added: add, removed: gone.map((g) => g.user_id) } });
      return { cursor, added: add.length, removed: gone.length };
    });
    this.publish(a.tenantId, r.cursor);
    return { added: r.added, removed: r.removed };
  }

  async messages(a: RequestActor, id: string, q: { before?: string; limit: number }) {
    this.staff(a);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.channel(tx, a, id);
      const rows = (await tx.query(`SELECT * FROM chat_message WHERE channel_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC, id DESC LIMIT $3`,
        [id, q.before ?? null, q.limit])).rows;
      return rows.map(msgOut);
    });
  }

  async post(a: RequestActor, channelId: string, b: { body: string; mentions?: string[]; attachmentDocIds?: string[] }) {
    this.staff(a);
    const id = uuidv7();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.channel(tx, a, channelId);
      const res = await this.sync.applyInTx(tx, a, { table: 'chat_message', id, baseVersion: 0, patch: { channel_id: channelId, body: b.body, mentions: b.mentions ?? [], attachment_doc_ids: b.attachmentDocIds ?? [] } });
      return { cursor: res.cursor, members: await this.members(tx, channelId), row: (await tx.query('SELECT * FROM chat_message WHERE id = $1', [id])).rows[0] };
    });
    this.publish(a.tenantId, r.cursor);
    return msgOut(r.row);
  }
  async edit(a: RequestActor, id: string, b: { body: string }) { return this.change(a, id, { body: b.body }, false); }
  async remove(a: RequestActor, id: string) { await this.change(a, id, {}, true); }
  private async change(a: RequestActor, id: string, patch: Record<string, unknown>, del: boolean) {
    this.staff(a);
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const m = (await tx.query('SELECT * FROM chat_message WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
      if (!m) throw new NotFoundException();
      await this.channel(tx, a, m.channel_id);
      if (m.author_id !== a.userId) throw new ForbiddenException({ message: 'Only the author', code: 'not_author' });
      const res = await this.sync.applyInTx(tx, a, { table: 'chat_message', id, baseVersion: m.version, patch, delete: del });
      return { cursor: res.cursor, row: (await tx.query('SELECT * FROM chat_message WHERE id = $1', [id])).rows[0] };
    });
    this.publish(a.tenantId, r.cursor);
    return msgOut(r.row);
  }
  async markRead(a: RequestActor, channelId: string, b: { messageId: string }) {
    this.staff(a);
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.channel(tx, a, channelId);
      const m = (await tx.query('SELECT * FROM chat_member WHERE channel_id = $1 AND user_id = $2 AND deleted_at IS NULL', [channelId, a.userId])).rows[0];
      return this.sync.applyInTx(tx, a, { table: 'chat_member', id: m.id, baseVersion: m.version, patch: { last_read_message_id: b.messageId, last_read_at: this.clock.now().toISOString() } });
    });
    this.publish(a.tenantId, r.cursor, [a.userId]);
  }
}
