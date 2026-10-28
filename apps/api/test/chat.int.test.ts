import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Clock } from '../src/common/clock.js';
import { uuidv7 } from '../src/db/ids.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let S: Session; let A: Session;
let clock: Clock;
const NOW = new Date('2026-10-15T11:00:00+05:30');
const H = (s: Session) => bearer(s.accessToken);
const pull = async (s: Session) => (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(s)).expect(200)).body.changes as Array<{ table: string; id: string; deleted: boolean; fields: Record<string, unknown> }>;
const push = async (s: Session, m: Record<string, unknown>) => (await t.http().post('/v1/sync/push').set(H(s)).send({ mutations: [{ key: `k-${randomUUID()}`, baseVersion: 0, ...m }] }).expect(200)).body.results[0];

beforeAll(async () => {
  t = await bootApp();
  clock = t.app.get(Clock); clock.set(NOW);
  P = await t.signup('chatfirm');
  M = await t.addUser(P, 'chatfirm', 'Mohan', 'manager');
  S = await t.addUser(P, 'chatfirm', 'Sita', 'senior');
  A = await t.addUser(P, 'chatfirm', 'Arun', 'article');
}, 60_000);
afterAll(() => t?.close());

describe('team chat', () => {
  let group: string; let msg: string;
  it('syncs channels and messages to members only; mentions notify through the notify pipeline', async () => {
    group = (await t.http().post('/v1/chat/channels').set(H(P)).send({ kind: 'group', name: 'GST desk', memberIds: [S.userId, M.userId] }).expect(201)).body.id;
    const posted = (await t.http().post(`/v1/chat/channels/${group}/messages`).set(H(P)).send({ body: `@[Sita](${S.userId}) please check the 3B` }).expect(201)).body;
    msg = posted.id;
    expect(posted.mentions).toEqual([S.userId]);
    const n = await t.sql<{ category: string; title: string; body: string }>(`SELECT category, title, body FROM notification WHERE user_id = $1`, [S.userId]);
    expect(n).toEqual([{ category: 'chat.mentioned', title: 'Partner mentioned you in GST desk', body: '@Sita please check the 3B' }]);
    expect(await t.sql(`SELECT 1 FROM job_queue WHERE kind = 'notification.deliver'`)).toHaveLength(1);
    const sp = await pull(S);
    expect(sp.filter((c) => c.table === 'chat_channel').map((c) => c.id)).toEqual([group]);
    expect(sp.find((c) => c.table === 'chat_message')?.fields.body).toContain('please check');
    const ap = await pull(A); // article, not a member
    expect(ap.filter((c) => c.table.startsWith('chat_'))).toEqual([]);
    await t.http().get(`/v1/chat/channels/${group}/messages`).set(H(A)).expect(404);
    expect((await t.http().get('/v1/chat/channels').set(H(S)).expect(200)).body[0]).toMatchObject({ id: group, unread: 1 });
    await t.http().post(`/v1/chat/channels/${group}/read`).set(H(S)).send({ messageId: msg }).expect(204);
    expect((await t.http().get('/v1/chat/channels').set(H(S))).body[0].unread).toBe(0);
    // Audit never carries message bodies.
    expect(JSON.stringify(await t.sql('SELECT diff FROM audit_log'))).not.toContain('please check');
  });

  it('validates device-created messages (member, length, mentions, attachments) the same as REST', async () => {
    const id = uuidv7();
    expect(await push(S, { table: 'chat_message', id, patch: { channel_id: group, body: `offline note @[Mohan](${M.userId})` } })).toMatchObject({ status: 'applied' });
    expect((await t.sql<{ author_id: string; mentions: string[] }>('SELECT author_id, mentions FROM chat_message WHERE id = $1', [id]))[0]).toEqual({ author_id: S.userId, mentions: [M.userId] });
    expect((await t.sql(`SELECT 1 FROM notification WHERE user_id = $1 AND category = 'chat.mentioned'`, [M.userId])).length).toBe(1);
    expect(await push(A, { table: 'chat_message', id: uuidv7(), patch: { channel_id: group, body: 'let me in' } })).toMatchObject({ status: 'rejected', reason: 'not_found' }); // not a member
  });

  it('enforces author-only, time-limited edits and deletes; delete scrubs the content', async () => {
    await t.http().patch(`/v1/chat/messages/${msg}`).set(H(S)).send({ body: 'hijack' }).expect(403);
    const e = (await t.http().patch(`/v1/chat/messages/${msg}`).set(H(P)).send({ body: `@[Sita](${S.userId}) please check the 3B today` }).expect(200)).body;
    expect(e.editedAt).toBe(NOW.toISOString());
    clock.set(new Date(NOW.getTime() + 16 * 60_000));
    expect((await t.http().patch(`/v1/chat/messages/${msg}`).set(H(P)).send({ body: 'late' }).expect(400)).body.code).toBe('edit_window_closed');
    await t.http().delete(`/v1/chat/messages/${msg}`).set(H(P)).expect(403);
    const fresh = (await t.http().post(`/v1/chat/channels/${group}/messages`).set(H(P)).send({ body: 'typo msg' }).expect(201)).body.id;
    await t.http().delete(`/v1/chat/messages/${fresh}`).set(H(P)).expect(204);
    expect((await t.sql<{ body: string; deleted: boolean }>('SELECT body, deleted_at IS NOT NULL AS deleted FROM chat_message WHERE id = $1', [fresh]))[0]).toEqual({ body: '', deleted: true });
    clock.set(NOW);
  });

  it('refuses bad device pushes with reasons', async () => {
    const r = async (patch: Record<string, unknown>) => (await push(S, { table: 'chat_message', id: uuidv7(), patch: { channel_id: group, ...patch } })).reason;
    expect(await r({ body: 'x'.repeat(4001) })).toBe('too_long');
    expect(await r({ body: '   ' })).toBe('empty');
    expect(await r({ body: 'hi', mentions: [A.userId] })).toBe('invalid:mentions');
    expect(await r({ body: 'see file', attachment_doc_ids: [randomUUID()] })).toBe('invalid:attachment_doc_ids');
    const doc = uuidv7();
    await t.sql(`INSERT INTO document (id, tenant_id, name, mime, size, sha256, storage_key, uploaded_by) VALUES ($1,$2,'memo.pdf','application/pdf',1,'x','k',$3)`, [doc, P.tenantId, S.userId]);
    expect((await push(S, { table: 'chat_message', id: uuidv7(), patch: { channel_id: group, body: 'see file', attachment_doc_ids: [doc] } })).status).toBe('applied');
    expect((await push(M, { table: 'chat_message', id: uuidv7(), patch: { channel_id: group, body: 'mine', attachment_doc_ids: [doc] } })).reason).toBe('invalid:attachment_doc_ids'); // not Mohan's, firm doc needs firm-wide documents:view
  });

  it('client-linked channels require client visibility for every member; removal revokes on devices', async () => {
    const cid = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Navkar Textiles', entityType: 'PARTNERSHIP' }).expect(201)).body.id;
    await t.http().post('/v1/chat/channels').set(H(S)).send({ kind: 'client', clientId: cid }).expect(404);
    expect((await t.http().post('/v1/chat/channels').set(H(P)).send({ kind: 'client', clientId: cid, memberIds: [S.userId] }).expect(400)).body.code).toBe('member_cannot_view_client');
    await t.http().put(`/v1/clients/${cid}/access`).set(H(P)).send({ staffIds: [S.userId] }).expect(204);
    const ch = (await t.http().post('/v1/chat/channels').set(H(P)).send({ kind: 'client', clientId: cid, memberIds: [S.userId] }).expect(201)).body.id;
    await t.http().post(`/v1/chat/channels/${ch}/messages`).set(H(S)).send({ body: 'docs pending' }).expect(201);
    const before = (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(S))).body.cursor;
    await t.http().post(`/v1/chat/channels/${ch}/members`).set(H(S)).send({ remove: [S.userId] }).expect(403); // owner only
    await t.http().post(`/v1/chat/channels/${ch}/members`).set(H(P)).send({ remove: [S.userId] }).expect(200);
    const after = (await t.http().get(`/v1/sync/pull?since=${before}&limit=1000`).set(H(S))).body.changes as Array<{ table: string; id: string; deleted: boolean }>;
    expect(after.filter((c) => c.table === 'chat_message' && c.deleted)).toHaveLength(1);
    expect(after.some((c) => c.table === 'chat_channel' && c.id === ch && c.deleted)).toBe(true);
    await t.http().post(`/v1/chat/channels/${ch}/messages`).set(H(S)).send({ body: 'still here?' }).expect(404);
  });

  it('direct chats are one per pair; team channels take the team members', async () => {
    const d1 = (await t.http().post('/v1/chat/channels').set(H(S)).send({ kind: 'direct', memberIds: [M.userId] }).expect(201)).body;
    const d2 = (await t.http().post('/v1/chat/channels').set(H(M)).send({ kind: 'direct', memberIds: [S.userId] }).expect(201)).body;
    expect(d2).toEqual({ id: d1.id, created: false });
    const team = (await t.http().post('/v1/teams').set(H(P)).send({ name: 'Audit team', leadUserId: M.userId, memberIds: [S.userId, A.userId] }).expect(201)).body.id;
    const tc = (await t.http().post('/v1/chat/channels').set(H(P)).send({ kind: 'team', teamId: team }).expect(201)).body.id;
    const members = await t.sql<{ user_id: string }>('SELECT user_id FROM chat_member WHERE channel_id = $1 ORDER BY user_id', [tc]);
    expect(members.map((m) => m.user_id).sort()).toEqual([P.userId, M.userId, S.userId, A.userId].sort());
    // Articles chat too (no communication grant needed for team chat).
    await t.http().post(`/v1/chat/channels/${tc}/messages`).set(H(A)).send({ body: 'hello team' }).expect(201);
    expect((await pull(A)).filter((c) => c.table === 'chat_message')).toHaveLength(1);
  });
});
