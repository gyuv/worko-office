import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocalRow } from '@worko/sync';
import { formatDateTime } from '@worko/i18n';
import { Hash, Lock, Briefcase, Paperclip, Plus, Users, User, Send, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { absoluteUrl, multipart } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { getEngine, getStore, syncNow, useSync } from '../../lib/sync';
import { useUsers } from '../tasks/shared';
import { as, body, useCommError, useCommSettings } from './api';
import { bodySegments, filterMembers, insertMention, mentionQuery, sortMessages, unreadCounts, type ChatMember, type ChatMessage } from './logic';

async function openDocument(id: string) {
  const r = await unwrap(api.POST('/documents/{id}/download-url', { params: { path: { id } }, body: {} }));
  window.open(absoluteUrl(r.url), '_blank', 'noopener');
}

type Channel = { id: string; kind: 'team' | 'branch' | 'direct' | 'client' | 'group'; name: string; clientId: string | null; archived: boolean };

/** Rows of a synced table from the local store; re-reads when sync bumps the table. */
export function useLocalTable(table: string): LocalRow[] {
  const v = useSync((s) => s.versions[table] ?? 0);
  const [rows, setRows] = useState<LocalRow[]>([]);
  useEffect(() => {
    let live = true;
    void getStore()?.list(table).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [table, v]);
  return rows;
}

const toChannel = (r: LocalRow): Channel => ({ id: r.id, kind: r.fields.kind as Channel['kind'], name: String(r.fields.name ?? ''), clientId: (r.fields.client_id as string) ?? null, archived: !!r.fields.archived });
const toMember = (r: LocalRow): ChatMember => ({ id: r.id, channelId: String(r.fields.channel_id), userId: String(r.fields.user_id), role: (r.fields.role as string) ?? null,
  lastReadMessageId: (r.fields.last_read_message_id as string) ?? null, lastReadAt: (r.fields.last_read_at as string) ?? null, muted: !!r.fields.muted });
const toMessage = (r: LocalRow): ChatMessage => ({ id: r.id, channelId: String(r.fields.channel_id), authorId: (r.fields.author_id as string) ?? null, body: String(r.fields.body ?? ''),
  mentions: (r.fields.mentions as string[]) ?? [], attachmentDocIds: (r.fields.attachment_doc_ids as string[]) ?? [], editedAt: (r.fields.edited_at as string) ?? null,
  createdAt: (r.fields.created_at as string) ?? null, pending: !r.version });

export function useChat() {
  const channels = useLocalTable('chat_channel').map(toChannel);
  const members = useLocalTable('chat_member').map(toMember);
  const messages = useLocalTable('chat_message').map(toMessage);
  return { channels, members, messages };
}

/** Team chat (D106): offline-first through the sync engine; channels/membership via REST. */
export function ChatScreen() {
  const t = useT();
  const me = useMe().data;
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  const { name } = useUsers();
  const { channels, members, messages } = useChat();
  const [creating, setCreating] = useState(false);
  const unread = useMemo(() => (me ? unreadCounts(me.id, members, messages) : new Map<string, number>()), [me, members, messages]);
  const title = (c: Channel) => {
    if (c.kind !== 'direct') return c.name;
    const other = members.find((m) => m.channelId === c.id && m.userId !== me?.id);
    return other ? name(other.userId) : c.name;
  };
  const lastAt = (id: string) => Math.max(0, ...messages.filter((m) => m.channelId === id && m.createdAt).map((m) => Date.parse(m.createdAt!)));
  const sorted = [...channels].filter((c) => !c.archived).sort((a, b) => lastAt(b.id) - lastAt(a.id) || title(a).localeCompare(title(b)));
  const active = channels.find((c) => c.id === params[0]) ?? null;
  const Icon = (k: Channel['kind']) => ({ team: Users, branch: Hash, direct: User, client: Briefcase, group: Lock })[k] ?? Hash;
  return (
    <div className="grid h-[calc(100vh-7rem)] gap-3 md:grid-cols-[16rem_1fr]">
      <aside className="card flex min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border p-2"><h1 className="font-semibold">{t('p7.nav.chat')}</h1>
          <button className="btn" aria-label={t('p7.chat.newChannel')} onClick={() => setCreating(true)}><Plus size={14} aria-hidden /></button></div>
        <ul className="min-h-0 flex-1 overflow-auto p-1" aria-label={t('p7.chat.channels')}>
          {sorted.map((c) => {
            const I = Icon(c.kind); const n = unread.get(c.id) ?? 0;
            return (
              <li key={c.id}><a href={`#/chat/${c.id}`} aria-current={active?.id === c.id ? 'page' : undefined}
                className={`flex items-center gap-2 rounded px-2 py-1.5 ${active?.id === c.id ? 'bg-surface-alt font-medium' : 'hover:bg-surface-alt'}`}>
                <I size={14} aria-hidden className="shrink-0 text-muted" /><span className={`flex-1 truncate ${n ? 'font-semibold' : ''}`}>{title(c)}</span>
                {n > 0 && <span className="rounded-full bg-primary px-1.5 text-xs text-primary-fg" data-testid={`unread-${c.id}`} aria-label={t('p7.chat.unread', { n })}>{n}</span>}
              </a></li>
            );
          })}
          {!sorted.length && <li className="p-2 text-sm text-muted">{t('p7.chat.noChannels')}</li>}
        </ul>
      </aside>
      <section className="card flex min-h-0 flex-col">
        {active && me ? <ChannelView key={active.id} channel={active} title={title(active)} me={me.id} members={members.filter((m) => m.channelId === active.id)}
          messages={sortMessages(messages.filter((m) => m.channelId === active.id))} /> : <p className="m-auto text-muted">{t('p7.chat.pick')}</p>}
      </section>
      {creating && <NewChannelDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); go(`chat/${id}`); }} />}
    </div>
  );
}

function ChannelView({ channel, title, me, members, messages }: { channel: Channel; title: string; me: string; members: ChatMember[]; messages: ChatMessage[] }) {
  const t = useT();
  const { name } = useUsers();
  const settings = useCommSettings().data;
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const windowMin = settings?.chat.editWindowMinutes ?? 15;
  const mine = members.find((m) => m.userId === me);
  const latest = [...messages].reverse().find((m) => m.createdAt && !m.pending);
  // Advance the read cursor (synced row; only our own member row is writable).
  useEffect(() => {
    if (!mine || !latest || mine.lastReadMessageId === latest.id) return;
    void getEngine()?.write('chat_member', mine.id, { last_read_message_id: latest.id, last_read_at: new Date().toISOString() }).then(() => syncNow());
  }, [mine, latest]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [messages.length]);
  const editable = (m: ChatMessage) => m.authorId === me && (!m.createdAt || Date.now() - Date.parse(m.createdAt) <= windowMin * 60_000);
  const remove = async (m: ChatMessage) => { if (!confirm(t('p7.chat.deleteConfirm'))) return; await getEngine()?.write('chat_message', m.id, {}, { delete: true }); void syncNow(); };
  return (
    <>
      <header className="flex items-center gap-2 border-b border-border p-2">
        <h2 className="flex-1 truncate font-semibold">{title}</h2>
        {channel.clientId && <a className="text-xs text-primary underline" href={`#/clients/${channel.clientId}`}>{t('p7.chat.openClient')}</a>}
        <button className="btn" onClick={() => setManaging(true)}><Users size={14} aria-hidden /> {members.length}</button>
      </header>
      <ol className="min-h-0 flex-1 space-y-2 overflow-auto p-3" aria-label={t('p7.chat.messages')} aria-live="polite">
        {messages.map((m) => (
          <li key={m.id} className="group" data-testid={`msg-${m.id}`}>
            <div className="flex items-baseline gap-2 text-xs text-muted"><span className="font-medium text-fg">{m.authorId ? name(m.authorId) : '…'}</span>
              {m.createdAt ? <time dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time> : <span>{t('p7.chat.sending')}</span>}
              {m.editedAt && <span>{t('p7.chat.edited')}</span>}
              {editable(m) && <span className="ml-auto hidden gap-1 group-hover:flex group-focus-within:flex">
                <button aria-label={t('p6.edit')} onClick={() => setEditing(m)}><Pencil size={12} /></button>
                <button aria-label={t('p6.delete')} onClick={() => void remove(m)}><Trash2 size={12} /></button></span>}
            </div>
            <p className="whitespace-pre-wrap break-words">{bodySegments(m.body).map((s, k) => s.mention
              ? <span key={k} className={`rounded px-0.5 ${s.mention === me ? 'bg-due-soon/20 font-medium' : 'text-primary'}`}>{s.text}</span> : <span key={k}>{s.text}</span>)}</p>
            {m.attachmentDocIds.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{m.attachmentDocIds.map((d, k) =>
              <button key={d} className="inline-flex items-center gap-1 rounded bg-surface-alt px-1.5 py-0.5 text-xs" onClick={() => void openDocument(d).catch(() => toast({ text: t('common.error'), tone: 'error' }))}>
                <Paperclip size={12} aria-hidden /> {t('p7.chat.attachment', { n: k + 1 })}</button>)}</div>}
          </li>
        ))}
        {!messages.length && <li className="text-sm text-muted">{t('p7.chat.empty')}</li>}
        <div ref={end} />
      </ol>
      <Composer channel={channel} me={me} members={members} editing={editing} onDoneEditing={() => setEditing(null)} maxLength={settings?.chat.maxLength ?? 4000} />
      {managing && <MembersDialog channel={channel} me={me} members={members} onClose={() => setManaging(false)} />}
    </>
  );
}

function Composer({ channel, me, members, editing, onDoneEditing, maxLength }: { channel: Channel; me: string; members: ChatMember[]; editing: ChatMessage | null; onDoneEditing(): void; maxLength: number }) {
  const t = useT();
  const err = useCommError();
  const { name } = useUsers();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [docs, setDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) { setText(editing.body); box.current?.focus(); } }, [editing]);
  const mq = mentionQuery(text, caret);
  const candidates = mq ? filterMembers(members.map((m) => ({ id: m.userId, name: name(m.userId) })), mq.query, me) : [];
  const pick = (u: { id: string; name: string }) => {
    const r = insertMention(text, mq!.start, caret, u);
    setText(r.text); setCaret(r.caret);
    requestAnimationFrame(() => { box.current?.setSelectionRange(r.caret, r.caret); box.current?.focus(); });
  };
  const send = async () => {
    const b = text.trim();
    if (!b && !docs.length) return;
    const engine = getEngine(); const store = getStore();
    if (editing) {
      await engine?.write('chat_message', editing.id, { body: b });
      onDoneEditing();
    } else if (engine && store) {
      const id = crypto.randomUUID();
      await engine.write('chat_message', id, { channel_id: channel.id, body: b, mentions: [], attachment_doc_ids: docs.map((d) => d.id) });
      // Local-only display fields until the server row arrives (author/created_at are server-set).
      const row = await store.get('chat_message', id);
      if (row) await store.put([{ ...row, fields: { ...row.fields, author_id: me } }]);
    } else {
      try { await as(api.POST('/chat/channels/{id}/messages', { params: { path: { id: channel.id } }, body: body({ body: b, attachmentDocIds: docs.map((d) => d.id) }) })); }
      catch (e) { toast({ text: err(e), tone: 'error' }); return; }
    }
    setText(''); setDocs([]); setCaret(0);
    void syncNow();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, candidates.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(candidates[Math.min(sel, candidates.length - 1)]!); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
    if (e.key === 'Escape' && editing) { setText(''); onDoneEditing(); }
  };
  const upload = async (f: File) => {
    setUploading(true);
    try {
      const r = await unwrap(api.POST('/documents', { body: multipart({ file: f, clientId: channel.clientId ?? undefined, category: 'Chat attachment' }) })) as { id: string };
      setDocs((d) => [...d, { id: r.id, name: f.name }]);
    } catch (e) { toast({ text: err(e), tone: 'error' }); } finally { setUploading(false); }
  };
  return (
    <div className="relative border-t border-border p-2">
      {candidates.length > 0 && <ul role="listbox" aria-label={t('p7.chat.mention')} className="card absolute bottom-full left-2 mb-1 w-64 shadow-lg">
        {candidates.map((u, i) => <li key={u.id} role="option" aria-selected={i === sel} onMouseDown={(e) => { e.preventDefault(); pick(u); }}
          className={`cursor-pointer px-3 py-1.5 ${i === sel ? 'bg-surface-alt' : ''}`}>{u.name}</li>)}
      </ul>}
      {editing && <div className="mb-1 text-xs text-muted">{t('p7.chat.editing')} <button className="underline" onClick={() => { setText(''); onDoneEditing(); }}>{t('common.cancel')}</button></div>}
      {docs.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{docs.map((d) => <span key={d.id} className="rounded bg-surface-alt px-1.5 text-xs">{d.name}
        <button className="ml-1" aria-label={t('p6.delete')} onClick={() => setDocs(docs.filter((x) => x.id !== d.id))}>×</button></span>)}</div>}
      <div className="flex items-end gap-2">
        {!editing && <label className="btn cursor-pointer" aria-label={t('p7.chat.attach')}><Paperclip size={14} aria-hidden />
          <input type="file" className="sr-only" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label>}
        <textarea ref={box} className="input min-h-10 flex-1" rows={2} maxLength={maxLength} aria-label={t('p7.chat.composer')} placeholder={t('p7.chat.placeholder')} value={text}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setSel(0); }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)} onKeyDown={onKey} />
        <button className="btn btn-primary" aria-label={t('p7.chat.send')} disabled={uploading || (!text.trim() && !docs.length)} onClick={() => void send()}><Send size={14} aria-hidden /></button>
      </div>
    </div>
  );
}

function NewChannelDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const t = useT();
  const err = useCommError();
  const can = useCan();
  const me = useMe().data;
  const { users } = useUsers();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => unwrap(api.GET('/teams')), retry: false, enabled: can('users', 'view') }).data ?? [];
  const [kind, setKind] = useState<'group' | 'direct' | 'client' | 'team' | 'branch'>('group');
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [dm, setDm] = useState('');
  const [client, setClient] = useState<PickedClient | null>(null);
  const [teamId, setTeamId] = useState('');
  const others = users.filter((u) => u.id !== me?.id);
  const m = useMutation({
    mutationFn: () => as<{ id: string; created: boolean }>(api.POST('/chat/channels', { body: body({
      kind, ...(name.trim() ? { name: name.trim() } : {}),
      ...(kind === 'direct' ? { memberIds: [dm] } : kind === 'group' || kind === 'client' ? { memberIds } : {}),
      ...(kind === 'client' ? { clientId: client?.id } : {}), ...(kind === 'team' ? { teamId } : {}),
    }) })),
    onSuccess: (r) => { void syncNow(); onCreated(r.id); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const ok = kind === 'direct' ? !!dm : kind === 'group' ? !!name.trim() : kind === 'client' ? !!client : kind === 'team' ? !!teamId : true;
  return (
    <Dialog title={t('p7.chat.newChannel')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ok) m.mutate(); }}>
        <Field label={t('p7.chat.kind')}><select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {(['group', 'direct', 'client', 'team', 'branch'] as const).map((k) => <option key={k} value={k}>{t(`p7.chat.kinds.${k}`)}</option>)}</select></Field>
        {kind === 'direct' ? <Field label={t('p7.chat.with')}><select className="input" value={dm} onChange={(e) => setDm(e.target.value)}>
          <option value="">{t('p6.select')}</option>{others.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          : <Field label={t('p7.f.name')} hint={kind === 'group' ? undefined : t('p7.chat.nameOptional')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        {kind === 'client' && <><ClientPicker label={t('p6.f.client')} value={client} onChange={setClient} /><p className="text-xs text-muted">{t('p7.chat.clientNote')}</p></>}
        {kind === 'team' && <Field label={t('p7.chat.team')}><select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">{t('p6.select')}</option>{teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
        {kind === 'branch' && <p className="text-xs text-muted">{t('p7.chat.branchNote')}</p>}
        {(kind === 'group' || kind === 'client') && <fieldset><legend className="label">{t('p7.chat.members')}</legend>
          <div className="max-h-40 space-y-0.5 overflow-auto">{others.map((u) => <label key={u.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={memberIds.includes(u.id)} onChange={() => setMemberIds(memberIds.includes(u.id) ? memberIds.filter((x) => x !== u.id) : [...memberIds, u.id])} /> {u.name}</label>)}</div></fieldset>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!ok || m.isPending}>{t('p7.chat.create')}</button></div>
      </form>
    </Dialog>
  );
}

function MembersDialog({ channel, me, members, onClose }: { channel: Channel; me: string; members: ChatMember[]; onClose(): void }) {
  const t = useT();
  const err = useCommError();
  const qc = useQueryClient();
  const { users, name } = useUsers();
  const [add, setAdd] = useState('');
  const owner = members.find((m) => m.userId === me)?.role === 'owner';
  const change = useMutation({
    mutationFn: (b: { add?: string[]; remove?: string[] }) => as<{ added: number; removed: number }>(api.POST('/chat/channels/{id}/members', { params: { path: { id: channel.id } }, body: body(b) })),
    onSuccess: () => { setAdd(''); void syncNow(); void qc.invalidateQueries({ queryKey: ['chat'] }); toast({ text: t('p6.saved'), tone: 'ok' }, 2000); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const fixed = channel.kind === 'direct';
  const ids = new Set(members.map((m) => m.userId));
  return (
    <Dialog title={t('p7.chat.membersOf', { name: channel.name })} onClose={onClose}>
      <ul className="mb-3 divide-y divide-border" aria-label={t('p7.chat.members')}>{members.map((m) => (
        <li key={m.id} className="flex items-center gap-2 py-1"><span className="flex-1">{name(m.userId)}{m.role === 'owner' && <span className="ml-1 text-xs text-muted">{t('p7.chat.owner')}</span>}</span>
          {owner && !fixed && m.userId !== me && <button className="btn" onClick={() => change.mutate({ remove: [m.userId] })}>{t('p7.chat.remove')}</button>}</li>
      ))}</ul>
      {owner && !fixed && <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (add) change.mutate({ add: [add] }); }}>
        <Field label={t('p7.chat.addMember')}><select className="input" value={add} onChange={(e) => setAdd(e.target.value)}>
          <option value="">{t('p6.select')}</option>{users.filter((u) => !ids.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <button className="btn btn-primary" disabled={!add || change.isPending}>{t('common.add')}</button></form>}
      {fixed && <p className="text-xs text-muted">{t('p7.chat.directFixed')}</p>}
      {!owner && !fixed && <p className="text-xs text-muted">{t('p7.chat.ownerOnly')}</p>}
    </Dialog>
  );
}

