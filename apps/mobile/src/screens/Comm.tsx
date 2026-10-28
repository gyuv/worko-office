import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDaysIso } from '@worko/domain';
import { formatDate, relativeTime, type MessageKey } from '@worko/i18n';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import {
  activeMentionQuery, bodyParts, buildEventPatch, canEditMessage, channelSummaries, commErrorKey, decodeMentions, encodeMentions, formFromEvent, groupAgenda,
  groupByDay, insertMention, isOwnEditable, istTime, markReadPatch, mentionCandidates, missingVars, namesFromBodies, toChannel, toEvent, toMember, toMessage, totalUnread,
  validateMessage, type EventForm as EventFormData, type MessageItem, type Person,
} from '../logic/comm';
import { telLink } from '../logic/links';
import { currentFy, todayIST } from '../logic/registers';
import { openDocument, pickImage, uploadChatPhoto } from '../net';
import { api, unwrap, useSession } from '../session';
import { getEngine, getStore, syncNow, useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui, useTable } from '../ui';
import { Header } from './Header';
import type { Nav } from './Stack';

const useUserId = () => useSession((x) => x.tokens?.userId ?? '');
const DIR_KEY = 'user_directory';

/**
 * Names for user ids: the staff list when the user may read it (cached in the encrypted store for offline use),
 * plus names learned from mention tokens in synced messages. Unknown ids fall back to a short label.
 */
export function usePeople(): Map<string, string> {
  const online = useSync((x) => x.online);
  const msgs = useTable('chat_message');
  const [cached, setCached] = useState<Record<string, string>>({});
  useEffect(() => { void getStore()?.getMeta(DIR_KEY).then((v) => { try { if (v) setCached(JSON.parse(v) as Record<string, string>); } catch { /* ignore */ } }); }, []);
  const q = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')), enabled: online, retry: false, staleTime: 600_000 });
  useEffect(() => {
    if (!q.data) return;
    const next = Object.fromEntries(q.data.map((u) => [u.id.toLowerCase(), u.name]));
    setCached(next); void getStore()?.setMeta(DIR_KEY, JSON.stringify(next));
  }, [q.data]);
  return useMemo(() => {
    const m = namesFromBodies(msgs.map((r) => String(r.fields.body ?? '')));
    for (const [k, v] of Object.entries(cached)) m.set(k, v);
    return m;
  }, [msgs, cached]);
}
const nameOf = (people: Map<string, string>, id: string) => people.get(id.toLowerCase()) ?? t('m.chat.member', { id: id.slice(0, 4) });

function useChat() {
  const ch = useTable('chat_channel'); const mem = useTable('chat_member'); const msg = useTable('chat_message');
  return useMemo(() => ({
    channels: ch.filter((r) => !r.deleted).map(toChannel),
    members: mem.filter((r) => !r.deleted).map(toMember),
    messages: msg.map(toMessage),
  }), [ch, mem, msg]);
}

/** Total unread chat messages (muted channels count only when I was mentioned). */
export function useChatUnread(): number {
  const me = useUserId();
  const { channels, members, messages } = useChat();
  return useMemo(() => totalUnread(channelSummaries(channels, members, messages, me)), [channels, members, messages, me]);
}

// ---------- channel list ----------

export function ChatList({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const me = useUserId();
  const { channels, members, messages } = useChat();
  const people = usePeople();
  const list = useMemo(() => channelSummaries(channels, members, messages, me), [channels, members, messages, me]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.chat.title')} onBack={onBack} />
      <FlatList data={list} keyExtractor={(x) => x.id}
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.chat.noChannels')}</Text>}
        renderItem={({ item }) => {
          const preview = item.last ? `${item.last.authorId === me ? t('m.chat.you') : nameOf(people, item.last.authorId)}: ${bodyParts(item.last.body).map((p) => p.text).join('') || t('m.chat.photo')}` : t('m.chat.noMessages');
          return (
            <Pressable style={s.row} onPress={() => nav.push({ name: 'chatThread', id: item.id })} accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${t('m.chat.unread', { count: item.unread })}`}>
              <Feather name={item.kind === 'direct' ? 'user' : item.kind === 'client' ? 'briefcase' : 'users'} size={18} color={theme.textMuted} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={[s.text, item.unread > 0 && { fontWeight: '600' }]} numberOfLines={1}>{item.name}{item.archived ? ` · ${t('m.chat.archived')}` : ''}</Text>
                <Text style={s.muted} numberOfLines={1}>{preview}</Text>
              </View>
              {item.muted && <Feather name="bell-off" size={14} color={theme.textMuted} style={{ marginHorizontal: 6 }} />}
              {item.unread > 0 && <Text style={[s.chip, { backgroundColor: item.mentioned ? theme.status.overdue : theme.primary, color: theme.primaryText }]}>
                {item.mentioned ? '@ ' : ''}{item.unread}</Text>}
            </Pressable>
          );
        }} />
    </View>
  );
}

// ---------- thread ----------

type Row = { kind: 'day'; day: string } | { kind: 'msg'; m: MessageItem };

export function ChatThread({ theme, id, onBack }: { theme: Theme; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const me = useUserId();
  const online = useSync((x) => x.online);
  const { channels, members, messages } = useChat();
  const people = usePeople();
  const channel = channels.find((c) => c.id === id);
  const chMembers = useMemo(() => members.filter((m) => m.channelId === id), [members, id]);
  const mine = chMembers.find((m) => m.userId === me);
  const msgs = useMemo(() => messages.filter((m) => m.channelId === id), [messages, id]);
  const memberPeople: Person[] = useMemo(() => chMembers.map((m) => ({ id: m.userId.toLowerCase(), name: nameOf(people, m.userId) })), [chMembers, people]);

  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<Person[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opening / receiving moves my own read cursor (synced; works offline).
  const lastId = msgs.length ? msgs[msgs.length - 1]!.id + msgs.length : '';
  const marked = useRef('');
  useEffect(() => {
    const patch = markReadPatch(mine, msgs, new Date());
    if (!patch || !mine || marked.current === patch.last_read_message_id) return;
    marked.current = patch.last_read_message_id;
    void getEngine()?.write('chat_member', mine.id, patch).then(() => syncNow());
  }, [lastId, mine, msgs]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const sec of groupByDay(msgs)) { out.push({ kind: 'day', day: sec.day }); for (const m of sec.data) out.push({ kind: 'msg', m }); }
    return out.reverse(); // inverted list: newest at the bottom
  }, [msgs]);

  const query = activeMentionQuery(draft);
  const candidates = query === null ? [] : mentionCandidates(memberPeople, query, me.toLowerCase());

  async function send() {
    setError(null);
    const body = encodeMentions(draft, picked);
    const v = validateMessage(body, chMembers.map((m) => m.userId), undefined, attachments.length);
    if (!v.ok) { setError(t(v.error)); return; }
    const engine = getEngine(); if (!engine) return;
    if (editing) await engine.write('chat_message', editing, { body: v.body, mentions: v.mentions });
    else await engine.write('chat_message', Crypto.randomUUID(), { channel_id: id, body: v.body, mentions: v.mentions, attachment_doc_ids: attachments });
    setDraft(''); setPicked([]); setEditing(null); setAttachments([]);
    void syncNow();
  }

  function actions(m: MessageItem) {
    if (!canEditMessage(m, me, new Date())) { if (m.authorId === me && !m.deleted) Alert.alert(t('m.chat.windowClosed')); return; }
    Alert.alert(t('m.chat.actions'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('m.chat.edit'), onPress: () => { const d = decodeMentions(m.body); setDraft(d.draft); setPicked(d.picked); setEditing(m.id); setAttachments([]); } },
      { text: t('m.chat.delete'), style: 'destructive', onPress: () => void getEngine()?.write('chat_message', m.id, {}, { delete: true }).then(() => syncNow()) },
    ]);
  }

  async function attach() {
    if (!online) { setError(t('m.chat.photoOffline')); return; }
    const f = await pickImage('library');
    if (!f || f === 'denied') return;
    setBusy(true); setError(null);
    try { const docId = await uploadChatPhoto(f, { clientId: channel?.clientId ?? null, fy: currentFy(), category: t('m.chat.photoCategory') }); setAttachments((a) => [...a, docId].slice(0, 10)); }
    catch (e) { setError(t('m.chat.photoFailed', { reason: (e as Error).message })); }
    finally { setBusy(false); }
  }

  if (!channel) return <View><Header theme={theme} title={t('m.chat.title')} onBack={onBack} /><Text style={s.muted}>{t('m.chat.gone')}</Text></View>;
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={channel.name} onBack={onBack} right={mine && (
        <Pressable style={s.icon} onPress={() => void getEngine()?.write('chat_member', mine.id, { muted: !mine.muted }).then(() => syncNow())}
          accessibilityRole="switch" accessibilityState={{ checked: mine.muted }} accessibilityLabel={t('m.chat.mute')}>
          <Feather name={mine.muted ? 'bell-off' : 'bell'} size={20} color={theme.primary} />
        </Pressable>)} />
      <Text style={s.muted}>{t('m.chat.members', { count: chMembers.length })}</Text>
      <FlatList inverted data={rows} keyExtractor={(r) => (r.kind === 'day' ? 'd' + r.day : r.m.id)} keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24, textAlign: 'center' }]}>{t('m.chat.noMessages')}</Text>}
        renderItem={({ item: r }) => r.kind === 'day'
          ? <Text style={[s.muted, { textAlign: 'center', marginVertical: 8 }]}>{r.day === todayIST() ? t('m.chat.today') : formatDate(r.day)}</Text>
          : <Bubble theme={theme} m={r.m} me={me} people={people} onLongPress={() => actions(r.m)} />} />
      {error && <Text accessibilityRole="alert" style={s.alert}>{error}</Text>}
      {candidates.length > 0 && (
        <ScrollView horizontal keyboardShouldPersistTaps="handled" style={{ maxHeight: 48 }} contentContainerStyle={{ gap: 6 }}>
          {candidates.map((c) => (
            <Pressable key={c.id} style={s.chipBtn} accessibilityRole="button" accessibilityLabel={t('m.chat.mentionPerson', { name: c.name })}
              onPress={() => { setDraft((d) => insertMention(d, c.name)); setPicked((p) => [...p.filter((x) => x.id !== c.id), c]); }}>
              <Text style={{ color: theme.text }}>@{c.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {(editing || attachments.length > 0) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <Text style={[s.muted, { flex: 1 }]}>{editing ? t('m.chat.editing') : t('m.chat.attached', { count: attachments.length })}</Text>
          <Pressable style={s.icon} onPress={() => { setEditing(null); setDraft(''); setPicked([]); setAttachments([]); }} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
            <Feather name="x" size={18} color={theme.textMuted} /></Pressable>
        </View>
      )}
      {channel.archived ? <Text style={s.muted}>{t('m.chat.archivedHint')}</Text> : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: 6 }}>
          {!editing && <Pressable style={[s.icon, !online && { opacity: 0.4 }]} onPress={() => void attach()} disabled={busy} accessibilityRole="button" accessibilityLabel={t('m.chat.attachPhoto')}>
            {busy ? <ActivityIndicator /> : <Feather name="image" size={20} color={theme.primary} />}</Pressable>}
          <TextInput style={[s.input, { flex: 1, maxHeight: 120 }]} value={draft} onChangeText={setDraft} multiline placeholder={t('m.chat.placeholder')}
            placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.chat.placeholder')} />
          <Pressable style={s.icon} onPress={() => void send()} accessibilityRole="button" accessibilityLabel={editing ? t('m.chat.save') : t('m.chat.send')}>
            <Feather name={editing ? 'check' : 'send'} size={20} color={theme.primary} /></Pressable>
        </View>
      )}
    </View>
  );
}

function Bubble({ theme, m, me, people, onLongPress }: { theme: Theme; m: MessageItem; me: string; people: Map<string, string>; onLongPress(): void }) {
  const s = ui(theme);
  const own = m.authorId === me;
  return (
    <Pressable onLongPress={onLongPress} accessibilityHint={own ? t('m.chat.longPress') : undefined}
      style={{ alignSelf: own ? 'flex-end' : 'flex-start', maxWidth: '85%', marginVertical: 3, padding: 8, borderRadius: 8, backgroundColor: own ? theme.surfaceAlt : theme.surface, borderWidth: 1, borderColor: theme.border }}>
      {!own && <Text style={[s.muted, { fontWeight: '600' }]}>{nameOf(people, m.authorId)}</Text>}
      {m.deleted ? <Text style={[s.muted, { fontStyle: 'italic' }]}>{t('m.chat.deleted')}</Text> : (
        <Text style={s.text} selectable>
          {bodyParts(m.body).map((p, i) => <Text key={i} style={p.userId ? { color: theme.primary, fontWeight: p.userId === me.toLowerCase() ? '700' : '600' } : undefined}>{p.text}</Text>)}
        </Text>
      )}
      {!m.deleted && m.attachments.map((d) => (
        <Pressable key={d} onPress={() => void openDocument(d).catch(() => Alert.alert(t('m.chat.photoOffline')))} accessibilityRole="link" style={{ minHeight: 40, justifyContent: 'center' }}>
          <Text style={{ color: theme.primary }}><Feather name="image" size={14} /> {t('m.chat.openPhoto')}</Text>
        </Pressable>
      ))}
      <Text style={[s.muted, { fontSize: 11, textAlign: 'right' }]}>{istTime(m.createdAt)}{m.editedAt && !m.deleted ? ` · ${t('m.chat.edited')}` : ''}</Text>
    </Pressable>
  );
}

// ---------- calendar ----------

const KIND_KEY: Record<string, MessageKey> = { meeting: 'm.cal.kind.meeting', personal: 'm.cal.kind.personal', appointment: 'm.cal.kind.appointment', external: 'm.cal.kind.external' };

export function Calendar({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const me = useUserId();
  const rows = useTable('calendar_event');
  const events = useMemo(() => rows.filter((r) => !r.deleted).map(toEvent), [rows]);
  const [day, setDay] = useState(todayIST());
  const [mode, setMode] = useState<'agenda' | 'day'>('agenda');
  const sections = useMemo(() => groupAgenda(events, day, mode === 'day' ? 1 : 14), [events, day, mode]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.cal.title')} onBack={onBack} right={
        <Pressable style={s.icon} onPress={() => nav.push({ name: 'eventForm', date: day })} accessibilityRole="button" accessibilityLabel={t('m.cal.new')}>
          <Feather name="plus" size={22} color={theme.primary} /></Pressable>} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Pressable style={s.icon} onPress={() => setDay((d) => addDaysIso(d, mode === 'day' ? -1 : -7))} accessibilityRole="button" accessibilityLabel={t('m.cal.prev')}>
          <Feather name="chevron-left" size={20} color={theme.text} /></Pressable>
        <Pressable onPress={() => setDay(todayIST())} accessibilityRole="button" style={{ flex: 1 }}><Text style={[s.text, { textAlign: 'center' }]}>{formatDate(day)}</Text></Pressable>
        <Pressable style={s.icon} onPress={() => setDay((d) => addDaysIso(d, mode === 'day' ? 1 : 7))} accessibilityRole="button" accessibilityLabel={t('m.cal.next')}>
          <Feather name="chevron-right" size={20} color={theme.text} /></Pressable>
      </View>
      <View style={{ flexDirection: 'row', gap: 6, marginVertical: 6 }}>
        {(['agenda', 'day'] as const).map((x) => (
          <Pressable key={x} onPress={() => setMode(x)} style={[s.chipBtn, mode === x && { backgroundColor: theme.primary, borderColor: theme.primary }]} accessibilityRole="button" accessibilityState={{ selected: mode === x }}>
            <Text style={{ color: mode === x ? theme.primaryText : theme.text }}>{t(x === 'agenda' ? 'm.cal.agenda' : 'm.cal.day')}</Text>
          </Pressable>
        ))}
      </View>
      <FlatList data={sections} keyExtractor={(x) => x.day}
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.cal.empty')}</Text>}
        renderItem={({ item: sec }) => (
          <View>
            <Text style={s.h2}>{sec.day === todayIST() ? `${t('m.chat.today')} · ${formatDate(sec.day)}` : formatDate(sec.day)}</Text>
            {sec.data.map((e) => {
              const editable = isOwnEditable(e, me);
              return (
                <Pressable key={e.id} style={s.row} accessibilityRole="button"
                  onPress={() => editable ? nav.push({ name: 'eventForm', id: e.id }) : Alert.alert(e.title, [e.location, e.description].filter(Boolean).join('\n') || t(KIND_KEY[e.kind]!))}>
                  <Text style={[s.muted, { width: 92 }]}>{e.allDay ? t('m.cal.allDay') : `${istTime(e.startsAt)}–${istTime(e.endsAt)}`}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.text} numberOfLines={1}>{e.title}</Text>
                    <Text style={s.muted} numberOfLines={1}>{[t(KIND_KEY[e.kind]!), e.location, e.ownerId !== me ? t('m.cal.invited') : ''].filter(Boolean).join(' · ')}</Text>
                  </View>
                  {!editable && <Feather name="lock" size={14} color={theme.textMuted} />}
                </Pressable>
              );
            })}
          </View>
        )} />
    </View>
  );
}

export function EventForm({ theme, nav, id, date, onBack }: { theme: Theme; nav: Nav; id?: string; date?: string; onBack?: () => void }) {
  const s = ui(theme);
  const me = useUserId();
  const rows = useTable('calendar_event');
  const people = usePeople();
  const existing = useMemo(() => { const r = id ? rows.find((x) => x.id === id && !x.deleted) : undefined; return r ? toEvent(r) : undefined; }, [rows, id]);
  const [f, setF] = useState<EventFormData>({ kind: 'meeting', title: '', date: date ?? todayIST(), start: '10:00', end: '10:30', allDay: false, location: '', description: '', attendeeIds: [] });
  const loaded = useRef(false);
  useEffect(() => { if (existing && !loaded.current) { loaded.current = true; setF(formFromEvent(existing)); } }, [existing]);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<EventFormData>) => setF((x) => ({ ...x, ...p }));
  const readOnly = !!existing && !isOwnEditable(existing, me);
  const others = [...people.entries()].filter(([u]) => u !== me.toLowerCase()).sort((a, b) => a[1].localeCompare(b[1]));

  async function save() {
    const r = buildEventPatch(f);
    if (!r.ok) { setError(t(r.error)); return; }
    await getEngine()?.write('calendar_event', id ?? Crypto.randomUUID(), r.patch);
    void syncNow(); nav.pop();
  }
  const field = (label: MessageKey, key: 'title' | 'date' | 'start' | 'end' | 'location' | 'description', ph?: string) => (
    <><Text style={s.label}>{t(label)}</Text>
      <TextInput style={s.input} value={f[key]} editable={!readOnly} onChangeText={(v) => set({ [key]: v })} placeholder={ph} placeholderTextColor={theme.textMuted} accessibilityLabel={t(label)} /></>
  );
  return (
    <View>
      <Header theme={theme} title={id ? t('m.cal.edit') : t('m.cal.new')} onBack={onBack} />
      {readOnly && <Text style={s.alert}>{t('m.cal.readOnly')}</Text>}
      {error && <Text accessibilityRole="alert" style={s.alert}>{error}</Text>}
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
        {(['meeting', 'personal'] as const).map((k) => (
          <Pressable key={k} disabled={readOnly} onPress={() => set({ kind: k })} style={[s.chipBtn, f.kind === k && { backgroundColor: theme.primary, borderColor: theme.primary }]} accessibilityRole="radio" accessibilityState={{ checked: f.kind === k }}>
            <Text style={{ color: f.kind === k ? theme.primaryText : theme.text }}>{t(KIND_KEY[k]!)}</Text>
          </Pressable>
        ))}
      </View>
      {field('m.cal.titleField', 'title')}
      {field('m.cal.date', 'date', 'YYYY-MM-DD')}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
        <Text style={[s.text, { flex: 1 }]}>{t('m.cal.allDay')}</Text>
        <Switch value={f.allDay} disabled={readOnly} onValueChange={(v) => set({ allDay: v })} accessibilityLabel={t('m.cal.allDay')} />
      </View>
      {!f.allDay && <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>{field('m.cal.start', 'start', 'HH:MM')}</View>
        <View style={{ flex: 1 }}>{field('m.cal.end', 'end', 'HH:MM')}</View>
      </View>}
      {field('m.cal.location', 'location')}
      {field('m.cal.notes', 'description')}
      {f.kind === 'meeting' && others.length > 0 && <>
        <Text style={s.label}>{t('m.cal.attendees')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {others.map(([u, name]) => {
            const on = f.attendeeIds.map((x) => x.toLowerCase()).includes(u);
            return (
              <Pressable key={u} disabled={readOnly} onPress={() => set({ attendeeIds: on ? f.attendeeIds.filter((x) => x.toLowerCase() !== u) : [...f.attendeeIds, u] })}
                style={[s.chipBtn, on && { backgroundColor: theme.primary, borderColor: theme.primary }]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                <Text style={{ color: on ? theme.primaryText : theme.text }}>{name}</Text>
              </Pressable>
            );
          })}
        </View>
      </>}
      {!readOnly && <Pressable style={s.button} onPress={() => void save()} accessibilityRole="button"><Text style={s.buttonText}>{t('m.cal.save')}</Text></Pressable>}
      {!readOnly && id && <Pressable style={[s.ghost, { marginTop: 12 }]} accessibilityRole="button" onPress={() => Alert.alert(t('m.cal.delete'), f.title, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('m.cal.delete'), style: 'destructive', onPress: async () => { await getEngine()?.write('calendar_event', id, {}, { delete: true }); void syncNow(); nav.pop(); } }])}>
        <Text style={[s.ghostText, { color: theme.status.overdue }]}>{t('m.cal.delete')}</Text></Pressable>}
      <Text style={[s.muted, { marginTop: 12 }]}>{t('m.cal.offlineHint')}</Text>
    </View>
  );
}

// ---------- client timeline (REST, online) ----------

type Tpl = { id: string; name: string; channel: 'email' | 'whatsapp' | 'sms'; category: 'transactional' | 'utility' | 'marketing'; variables: string[]; body: string };

export function ClientTimeline({ theme, clientId, onBack }: { theme: Theme; clientId: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const qc = useQueryClient();
  const key = ['timeline', clientId];
  const q = useQuery({ queryKey: key, enabled: online, queryFn: () => unwrap(api.GET('/clients/{id}/timeline', { params: { path: { id: clientId }, query: { limit: 50 } } })) });
  const [mode, setMode] = useState<'none' | 'note' | 'call' | 'template'>('none');
  const [body, setBody] = useState(''); const [mins, setMins] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const log = useMutation({
    mutationFn: () => unwrap(api.POST('/clients/{id}/timeline', { params: { path: { id: clientId } }, body: {
      channel: mode === 'call' ? 'call' : 'note', body: body.trim(), direction: 'out', callMinutes: mode === 'call' && /^\d+$/.test(mins) ? Number(mins) : null } })),
    onSuccess: () => { setBody(''); setMins(''); setMode('none'); setMsg(t('m.comm.logged')); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => setMsg(t('m.comm.err.failedWith', { reason: (e as Error).message })),
  });
  if (!online) return <View><Header theme={theme} title={t('m.comm.timeline')} onBack={onBack} /><Text style={s.alert}>{t('m.comm.offline')}</Text></View>;
  const items = q.data?.items ?? [];
  return (
    <FlatList data={items} keyExtractor={(x) => `${x.kind}:${x.id}`} keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<View>
        <Header theme={theme} title={t('m.comm.timeline')} onBack={onBack} />
        {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          {(['note', 'call', 'template'] as const).map((m) => (
            <Pressable key={m} style={[s.ghost, mode === m && { borderColor: theme.primary }]} onPress={() => { setMsg(null); setMode(mode === m ? 'none' : m); }} accessibilityRole="button">
              <Feather name={m === 'note' ? 'edit-3' : m === 'call' ? 'phone' : 'send'} size={16} color={theme.primary} />
              <Text style={s.ghostText}>{t(m === 'note' ? 'm.comm.logNote' : m === 'call' ? 'm.comm.logCall' : 'm.comm.sendTemplate')}</Text>
            </Pressable>
          ))}
        </View>
        {(mode === 'note' || mode === 'call') && <View>
          <TextInput style={[s.input, { marginTop: 8, minHeight: 80 }]} multiline value={body} onChangeText={setBody} placeholder={t(mode === 'call' ? 'm.comm.callSummary' : 'm.comm.note')}
            placeholderTextColor={theme.textMuted} accessibilityLabel={t(mode === 'call' ? 'm.comm.callSummary' : 'm.comm.note')} />
          {mode === 'call' && <TextInput style={[s.input, { marginTop: 8 }]} value={mins} onChangeText={setMins} keyboardType="number-pad" placeholder={t('m.comm.callMinutes')}
            placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.comm.callMinutes')} />}
          <Pressable style={[s.button, (!body.trim() || log.isPending) && { opacity: 0.5 }]} disabled={!body.trim() || log.isPending} onPress={() => log.mutate()} accessibilityRole="button">
            <Text style={s.buttonText}>{t('m.comm.save')}</Text></Pressable>
        </View>}
        {mode === 'template' && <SendTemplate theme={theme} clientId={clientId} onDone={(text) => { setMsg(text); void qc.invalidateQueries({ queryKey: key }); }} />}
        {q.isLoading && <ActivityIndicator style={{ marginTop: 16 }} />}
        {q.isError && <Text style={s.alert}>{(q.error as { status?: number }).status === 404 ? t('m.comm.noAccess') : t('common.error')}</Text>}
        {!q.isLoading && !items.length && !q.isError && <Text style={[s.muted, { marginTop: 16 }]}>{t('m.comm.empty')}</Text>}
      </View>}
      renderItem={({ item }) => (
        <View style={s.row}>
          <Feather name={item.kind === 'document' ? 'file-text' : item.kind === 'invoice' ? 'credit-card' : item.kind === 'task' ? 'check-square'
            : item.channel === 'call' ? 'phone' : item.channel === 'note' ? 'edit-3' : item.channel === 'email' ? 'mail' : 'message-circle'} size={18} color={theme.textMuted} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={s.text} numberOfLines={2}>{item.title || item.body || item.channel || item.kind}</Text>
            {!!item.title && !!item.body && <Text style={s.muted} numberOfLines={3}>{item.body}</Text>}
            <Text style={s.muted}>{[relativeTime(item.at ?? ''), item.direction === 'in' ? t('m.comm.inbound') : '', item.status, item.by, item.callMinutes ? t('m.comm.minutes', { count: item.callMinutes }) : ''].filter(Boolean).join(' · ')}</Text>
          </View>
        </View>
      )} />
  );
}

function SendTemplate({ theme, clientId, onDone }: { theme: Theme; clientId: string; onDone(text: string): void }) {
  const s = ui(theme);
  const tpls = useQuery({ queryKey: ['commTemplates', 'approved'], queryFn: () => unwrap(api.GET('/comm/templates', { params: { query: { status: 'approved' } } })) });
  const [sel, setSel] = useState<Tpl | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (tp: Tpl) => unwrap(api.POST('/comm/messages', { body: { clientId, channel: tp.channel, templateId: tp.id, vars, category: tp.category } })),
    onSuccess: (r) => { setSel(null); setVars({}); onDone(r.status === 'queued' ? t('m.comm.queued', { when: r.sendAt ? relativeTime(r.sendAt) : '' }) : t('m.comm.sent')); },
    onError: (e) => setErr(t(commErrorKey((e as { code?: string }).code), { reason: (e as Error).message })),
  });
  const list = (tpls.data ?? []) as unknown as Tpl[];
  if (tpls.isLoading) return <ActivityIndicator style={{ marginTop: 8 }} />;
  if (tpls.isError) return <Text style={s.alert}>{t('m.comm.noTemplates')}</Text>;
  if (!sel) return (
    <View style={{ marginTop: 8 }}>
      {!list.length && <Text style={s.muted}>{t('m.comm.noTemplates')}</Text>}
      {list.map((tp) => (
        <Pressable key={tp.id} style={s.row} onPress={() => { setErr(null); setSel(tp); setVars({}); }} accessibilityRole="button">
          <View style={{ flex: 1 }}><Text style={s.text}>{tp.name}</Text><Text style={s.muted} numberOfLines={2}>{`${tp.channel} · ${tp.body}`}</Text></View>
        </Pressable>
      ))}
    </View>
  );
  const missing = missingVars(sel.variables ?? [], vars);
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={s.h2}>{sel.name} · {sel.channel}</Text>
      <Text style={s.muted}>{sel.body}</Text>
      {(sel.variables ?? []).map((v) => (
        <View key={v}><Text style={s.label}>{v}</Text>
          <TextInput style={s.input} value={vars[v] ?? ''} onChangeText={(x) => setVars((o) => ({ ...o, [v]: x }))} accessibilityLabel={v} /></View>
      ))}
      {err && <Text accessibilityRole="alert" style={[s.alert, { color: theme.status.overdue }]}>{err}</Text>}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable style={[s.ghost, { marginTop: 12 }]} onPress={() => setSel(null)} accessibilityRole="button"><Text style={s.ghostText}>{t('common.cancel')}</Text></Pressable>
        <Pressable style={[s.button, { flex: 1 }, (missing.length > 0 || send.isPending) && { opacity: 0.5 }]} disabled={missing.length > 0 || send.isPending}
          onPress={() => { setErr(null); send.mutate(sel); }} accessibilityRole="button"><Text style={s.buttonText}>{t('m.comm.send')}</Text></Pressable>
      </View>
      {missing.length > 0 && <Text style={s.muted}>{t('m.comm.fillVars', { vars: missing.join(', ') })}</Text>}
    </View>
  );
}

// ---------- appointments today (REST, online) ----------

type Appt = { id: string; hostUserId: string; startsAt: string; endsAt: string; status: string; name?: string | null; phone?: string | null; purpose?: string | null };

export function Appointments({ theme, onBack }: { theme: Theme; onBack?: () => void }) {
  const s = ui(theme);
  const me = useUserId();
  const online = useSync((x) => x.online);
  const today = todayIST();
  const q = useQuery({ queryKey: ['appointments', today], enabled: online, queryFn: () => unwrap(api.GET('/booking/appointments', { params: { query: { from: today, to: today } } })) });
  const list = ((q.data ?? []) as unknown as Appt[]).filter((a) => a.hostUserId === me && a.startsAt.length > 0 && Date.parse(a.startsAt) > 0)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.cal.appointments')} onBack={onBack} />
      {!online && <Text style={s.alert}>{t('m.comm.offline')}</Text>}
      {q.isLoading && <ActivityIndicator style={{ marginTop: 16 }} />}
      <FlatList data={list} keyExtractor={(x) => x.id}
        ListEmptyComponent={online && !q.isLoading ? <Text style={[s.muted, { marginTop: 24 }]}>{t('m.cal.noAppointments')}</Text> : null}
        renderItem={({ item: a }) => {
          const tel = a.phone ? telLink(a.phone) : null;
          return (
            <View style={s.row}>
              <Text style={[s.muted, { width: 92 }]}>{`${istTime(new Date(a.startsAt).toISOString())}–${istTime(new Date(a.endsAt).toISOString())}`}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[s.text, a.status !== 'booked' && { textDecorationLine: 'line-through' }]} numberOfLines={1}>{a.name || t('m.cal.kind.appointment')}</Text>
                <Text style={s.muted} numberOfLines={2}>{[a.purpose, a.status !== 'booked' ? a.status : ''].filter(Boolean).join(' · ')}</Text>
              </View>
              {tel && <Pressable style={s.icon} onPress={() => void Linking.openURL(tel)} accessibilityRole="button" accessibilityLabel={t('m.client.call', { name: a.name ?? '' })}>
                <Feather name="phone" size={20} color={theme.primary} /></Pressable>}
            </View>
          );
        }} />
    </View>
  );
}
