import { can, clientCtx, mentionsOf, withinEditWindow } from '@worko/domain';
import { z } from 'zod';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params, visibilityOf } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { loadCommSettings } from './common.js';

/**
 * Sync rules for team chat and calendar events (D106). Chat rows reach members only; a client-linked channel also needs
 * clients:view + communication:view on its client. Device-created messages get the same validation as REST.
 */

type Row = Record<string, unknown>;
type Ctx = { now: Date; tx: Tx };

/** SQL: the actor is a live member of channel `ch` (and may see its client, if any). */
export function memberSql(a: RequestActor, p: Params, ch: string): string {
  const me = p.add(a.userId);
  return `EXISTS (SELECT 1 FROM chat_member mm JOIN chat_channel cc ON cc.id = mm.channel_id WHERE mm.channel_id = ${ch} AND mm.user_id = ${me}::uuid
    AND mm.deleted_at IS NULL AND cc.deleted_at IS NULL AND (cc.client_id IS NULL OR EXISTS (SELECT 1 FROM client c WHERE c.id = cc.client_id
    AND ${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'communication', 'view', p)})))`;
}
export async function isMember(tx: Tx, a: RequestActor, channelId: unknown): Promise<boolean> {
  if (typeof channelId !== 'string') return false;
  const p = new Params([channelId]);
  return !!(await tx.query(`SELECT 1 WHERE ${memberSql(a, p, '$1::uuid')}`, p.values)).rowCount;
}
async function memberIds(tx: Tx, channelId: string): Promise<Set<string>> {
  return new Set((await tx.query('SELECT user_id FROM chat_member WHERE channel_id = $1 AND deleted_at IS NULL', [channelId])).rows.map((r) => r.user_id as string));
}
const sameSet = (x: unknown, y: unknown) => JSON.stringify([...((x as string[]) ?? [])].sort()) === JSON.stringify([...((y as string[]) ?? [])].sort());

/** Attachments are existing documents the author can see (uploaded by them, or on a client they may view documents for). */
async function docsVisible(tx: Tx, a: RequestActor, ids: string[]): Promise<boolean> {
  if (!ids.length) return true;
  const docs = (await tx.query(`SELECT d.id AS doc_id, d.uploaded_by AS doc_uploader, d.client_id AS doc_client, c.* FROM document d LEFT JOIN client c ON c.id = d.client_id
    WHERE d.id = ANY($1) AND d.deleted_at IS NULL`, [ids])).rows;
  if (docs.length !== new Set(ids).size) return false;
  return docs.every((d) => d.doc_uploader === a.userId || (d.doc_client ? can(a, 'documents', 'view', clientCtx(visibilityOf(d))) : can(a, 'documents', 'view', { firmWide: true })));
}

export async function chatMessageError(a: RequestActor, cur: Row | null, next: Row, tx: Tx, ctx: Ctx): Promise<string | null> {
  const s = await loadCommSettings(tx);
  if (cur) {
    if (cur.author_id !== a.userId) return 'forbidden';
    if (!withinEditWindow(new Date(String(cur.created_at)), ctx.now, s.chat.editWindowMinutes)) return 'edit_window_closed';
  }
  const body = String(next.body ?? '');
  if (body.length > s.chat.maxLength) return 'too_long';
  const att = (next.attachment_doc_ids as string[]) ?? [];
  if (!body.trim() && !att.length) return 'empty';
  const members = await memberIds(tx, String(next.channel_id));
  if (!members.has(a.userId)) return 'not_member';
  if (((next.mentions as string[]) ?? []).some((u) => !members.has(u))) return 'invalid:mentions';
  if ((!cur || !sameSet(cur.attachment_doc_ids, att)) && !(await docsVisible(tx, a, att))) return 'invalid:attachment_doc_ids';
  return null;
}
/** Mentions = explicit ones ∪ `@[name](id)` in the body, members only. */
export async function chatMessageDerive(_a: RequestActor, cur: Row | null, patch: Row, ctx: Ctx): Promise<Row> {
  const out: Row = {};
  const channel = String(patch.channel_id ?? cur?.channel_id);
  if ('body' in patch || 'mentions' in patch) {
    const members = await memberIds(ctx.tx, channel);
    const body = String(patch.body ?? cur?.body ?? '');
    out.mentions = [...new Set([...(((patch.mentions ?? cur?.mentions) as string[]) ?? []), ...mentionsOf(body)])].filter((u) => members.has(u));
  }
  if (cur && 'body' in patch && patch.body !== cur.body) out.edited_at = ctx.now.toISOString();
  return out;
}
/** Newly mentioned members get a `chat.mentioned` notification (never the author). */
export async function chatMessageAfter(a: RequestActor, cur: Row | null, row: Row, ctx: Ctx): Promise<number> {
  const before = new Set(((cur?.mentions as string[]) ?? []));
  const fresh = ((row.mentions as string[]) ?? []).filter((u) => !before.has(u) && u !== a.userId);
  if (!fresh.length) return 0;
  const ch = (await ctx.tx.query('SELECT name FROM chat_channel WHERE id = $1', [row.channel_id])).rows[0];
  const who = (await ctx.tx.query('SELECT name FROM app_user WHERE id = $1', [a.userId])).rows[0]?.name ?? 'Someone';
  const preview = String(row.body ?? '').replace(/@\[([^\]]+)\]\([0-9a-f-]{36}\)/gi, '@$1').slice(0, 140);
  return (await insertNotifications(ctx.tx, a.tenantId, { userIds: fresh, category: 'chat.mentioned', title: `${who} mentioned you in ${ch?.name ?? 'chat'}`, body: preview,
    entityType: 'chat_message', entityId: String(row.id), dedupeKey: `mention:${row.id}`, fireAt: ctx.now })).cursor;
}
export async function canDeleteChatMessage(a: RequestActor, row: Row, tx: Tx, ctx: Ctx) {
  if (row.author_id !== a.userId || row.deleted_at) return false;
  return withinEditWindow(new Date(String(row.created_at)), ctx.now, (await loadCommSettings(tx)).chat.editWindowMinutes);
}

export const chatMessageWritable = {
  channel_id: z.string().uuid(), body: z.string().max(10_000), mentions: z.array(z.string().uuid()).max(50), attachment_doc_ids: z.array(z.string().uuid()).max(10),
};

// ---------- Calendar events ----------

/** Own events and events the actor attends; client-linked ones only while the client is visible (clients:view). */
export function calendarScopeSql(a: RequestActor, p: Params): string {
  const me = p.add(a.userId);
  return `(x.owner_id = ${me}::uuid OR ${me}::uuid = ANY(x.attendee_ids)) AND (x.client_id IS NULL OR EXISTS (SELECT 1 FROM client c WHERE c.id = x.client_id AND ${clientScopeSql(a, 'clients', 'view', p)}))`;
}
export const calendarWritable = {
  kind: z.enum(['meeting', 'personal']), title: z.string().trim().min(1).max(300), description: z.string().max(5000).nullable(), location: z.string().max(300).nullable(),
  starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }), all_day: z.boolean(), client_id: z.string().uuid().nullable(),
  attendee_ids: z.array(z.string().uuid()).max(50), busy: z.boolean(),
};
export async function calendarEventError(a: RequestActor, cur: Row | null, next: Row, tx: Tx): Promise<string | null> {
  if (!next.starts_at || !next.ends_at) return 'invalid:starts_at';
  if (Date.parse(String(next.ends_at)) < Date.parse(String(next.starts_at))) return 'invalid:ends_at';
  if (Date.parse(String(next.ends_at)) - Date.parse(String(next.starts_at)) > 31 * 86_400_000) return 'too_long';
  if (next.client_id && next.client_id !== cur?.client_id) {
    const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [next.client_id])).rows[0];
    if (!c || !can(a, 'clients', 'view', clientCtx(visibilityOf(c)))) return 'invalid:client_id';
  }
  const att = (next.attendee_ids as string[]) ?? [];
  if (att.length && !sameSet(att, cur?.attendee_ids)) {
    const n = (await tx.query(`SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1) AND status = 'active' AND kind = 'staff' AND deleted_at IS NULL`, [att])).rows[0].n;
    if (n !== new Set(att).size) return 'invalid:attendee_ids';
  }
  return null;
}
export const ownEditable = (a: RequestActor, row: Row) => row.owner_id === a.userId && ['meeting', 'personal'].includes(String(row.kind)) && !row.deleted_at;
