import { Feather } from '@expo/vector-icons';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PRODUCT } from '@worko/domain';
import { createTranslator, relativeTime, type MessageKey } from '@worko/i18n';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { TABS, type Tab } from './nav';
import { api, unwrap, useSession } from './session';
import { getEngine, getStore, startSync, stopSync, syncNow, toReminder, useSync } from './sync';
import { setupNotifications } from './notifications';
import { themeFor, type Theme } from './theme';
import { flushSignatures } from './net';
import { useBillingPerms } from './screens/Billing';
import { Stack } from './screens/Stack';
import { useChatUnread } from './screens/Comm';

const t = createTranslator('en-IN', { product: PRODUCT.name });
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

export function App() {
  const theme = themeFor(useColorScheme());
  const { tokens, ready, init } = useSession();
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { if (!tokens) qc.clear(); }, [tokens]);
  // Restart sync only when the signed-in session changes, not on every token refresh.
  const sessionKey = tokens ? `${tokens.tenantId}:${tokens.userId}:${tokens.sessionId}` : '';
  useEffect(() => {
    if (sessionKey) { const [tenantId, userId, sessionId] = sessionKey.split(':') as [string, string, string]; void startSync(tenantId, userId, sessionId); void setupNotifications(); }
    else void stopSync(false);
  }, [sessionKey]);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={qc}>
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
          <StatusBar style={theme.name === 'dark' ? 'light' : 'dark'} />
          {!ready ? <ActivityIndicator style={{ flex: 1 }} /> : tokens ? <Tabs theme={theme} /> : <Login theme={theme} />}
        </SafeAreaView>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function Login({ theme }: { theme: Theme }) {
  const s = styles(theme);
  const { setTokens, wiped } = useSession();
  const [firm, setFirm] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<MessageKey | null>(wiped ? 'auth.wiped' : null);
  const [busy, setBusy] = useState(false);

  // Phone OTP is the default on mobile (spec: "less input"); email+password is on web/desktop.
  async function submit() {
    setBusy(true); setError(null);
    try {
      if (!sent) { await unwrap(api.POST('/auth/otp/request', { body: { firm, phone } })); setSent(true); }
      else setTokens(await unwrap(api.POST('/auth/otp/verify', { body: { firm, phone, code, device: { platform: 'android', label: 'Android' } } })));
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 429 ? 'auth.locked' : status && status < 500 ? 'auth.invalid' : 'common.error');
    } finally { setBusy(false); }
  }

  return (
    <View style={s.center}>
      <Text style={s.h1}>{t('app.name')}</Text>
      <Text style={s.muted}>{t('auth.title')}</Text>
      {error && <Text accessibilityRole="alert" style={s.alert}>{t(error)}</Text>}
      <Text style={s.label}>{t('auth.firm')}</Text>
      <TextInput style={s.input} value={firm} onChangeText={setFirm} autoCapitalize="none" placeholder={t('auth.firmHint')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('auth.firm')} />
      <Text style={s.label}>{t('auth.phone')}</Text>
      <TextInput style={s.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="+91" placeholderTextColor={theme.textMuted} accessibilityLabel={t('auth.phone')} />
      {sent && <>
        <Text style={s.label}>{t('auth.otp')}</Text>
        <TextInput style={s.input} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} accessibilityLabel={t('auth.otp')} />
      </>}
      <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={submit} accessibilityRole="button">
        <Text style={s.buttonText}>{sent ? t('auth.signIn') : t('auth.sendOtp')}</Text>
      </Pressable>
    </View>
  );
}

function Tabs({ theme }: { theme: Theme }) {
  const s = styles(theme);
  const [tab, setTab] = useState<Tab>('home');
  const current = TABS.find((x) => x.key === tab)!;
  const [sub, setSub] = useState<'registers' | 'collections' | 'hr' | 'chat' | 'calendar' | 'appointments' | 'practice' | null>(null);
  useSignatureRetry();
  return (
    <View style={{ flex: 1 }}>
      <StatusStrip theme={theme} />
      <View style={{ flex: 1, padding: 16 }}>
        {tab === 'home' ? <Home theme={theme} /> : tab === 'tasks' ? <Stack theme={theme} root={{ name: 'tasks' }} /> : tab === 'clients' ? <Stack theme={theme} root={{ name: 'clients' }} />
          : tab === 'more' ? (sub ? <View style={{ flex: 1 }}>
            <Pressable onPress={() => setSub(null)} accessibilityRole="button" style={{ minHeight: 48, justifyContent: 'center' }}>
              <Text style={{ color: theme.primary, fontWeight: '600' }}>{t('nav.more')}</Text></Pressable>
            <Stack key={sub} theme={theme} root={{ name: sub }} /></View>
            : <More theme={theme} onRegisters={() => setSub('registers')} onCollections={() => setSub('collections')} onHr={() => setSub('hr')} onOpen={setSub} />) : tab === 'inbox' ? <Inbox theme={theme} />
          : <Text style={s.muted}>{t('home.comingSoon', { module: t(current.label), phase: current.phase ?? 0 })}</Text>}
      </View>
      <View style={s.tabbar} accessibilityRole="tablist">
        {TABS.map((x) => (
          <Pressable key={x.key} style={s.tab} onPress={() => setTab(x.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === x.key }}>
            <Feather name={x.icon} size={20} color={tab === x.key ? theme.primary : theme.textMuted} />
            <Text style={{ fontSize: 11, color: tab === x.key ? theme.primary : theme.textMuted }}>{t(x.label)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** Retry pending signature uploads when connectivity returns or a register entry syncs (gets its number). */
function useSignatureRetry() {
  const online = useSync((x) => x.online);
  const vIn = useSync((x) => x.versions.inward_entry ?? 0);
  const vOut = useSync((x) => x.versions.outward_entry ?? 0);
  useEffect(() => { if (online) void flushSignatures().catch(() => undefined); }, [online, vIn, vOut]);
}

/** Offline banner + sync state (spec §8/§13). */
function StatusStrip({ theme }: { theme: Theme }) {
  const { online, status, pending } = useSync();
  if (online && status !== 'offline' && !pending) return null;
  const text = !online || status === 'offline' ? t('common.offline') : t('sync.pending', { count: pending });
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 8, backgroundColor: theme.surfaceAlt }}>
      <Feather name={online ? 'refresh-cw' : 'wifi-off'} size={14} color={theme.text} />
      <Text style={{ color: theme.text, fontSize: 13, flex: 1 }}>{text}</Text>
    </View>
  );
}

type Item = ReturnType<typeof toReminder> & { requiresAck: boolean; escalationLevel: number };

function useInbox(): Item[] {
  const v = useSync((x) => x.versions.notification ?? 0);
  const [rows, setRows] = useState<Item[]>([]);
  useEffect(() => {
    let live = true;
    void getStore()?.list('notification').then((list) => {
      if (!live) return;
      const now = new Date();
      setRows(list.map((r) => ({ ...toReminder(r), requiresAck: !!r.fields.requires_ack, escalationLevel: Number(r.fields.escalation_level ?? 0) }))
        .filter((r) => new Date(r.fireAt) <= now && !(r.snoozedUntil && new Date(r.snoozedUntil) > now))
        .sort((a, b) => b.fireAt.localeCompare(a.fireAt)));
    });
    return () => { live = false; };
  }, [v]);
  return rows;
}

/** Works offline: read/ack are local writes that sync when the connection returns. */
function Inbox({ theme }: { theme: Theme }) {
  const s = styles(theme);
  const items = useInbox();
  const act = async (id: string, patch: Record<string, unknown>) => { await getEngine()?.write('notification', id, patch); void syncNow(); };
  if (!items.length) return <Text style={s.muted}>{t('notif.empty')}</Text>;
  return (
    <FlatList data={items} keyExtractor={(x) => x.id} renderItem={({ item }) => {
      const urgent = item.priority === 'critical' || item.priority === 'high';
      const now = new Date().toISOString();
      return (
        <Pressable style={s.row} onPress={() => !item.readAt && void act(item.id, { read_at: now })} accessibilityRole="button"
          accessibilityHint={item.readAt ? undefined : t('notif.markRead')}>
          <Feather name={item.escalationLevel ? 'shield' : urgent ? 'alert-octagon' : 'bell'} size={18} color={urgent ? theme.status.overdue : theme.textMuted} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={[s.text, !item.readAt && { fontWeight: '600' }]}>{item.title}</Text>
            {!!item.body && <Text style={s.muted}>{item.body}</Text>}
            <Text style={s.muted}>{relativeTime(item.fireAt)}{item.escalationLevel ? ` · ${t('notif.escalated', { level: item.escalationLevel })}` : ''}</Text>
          </View>
          {item.requiresAck && !item.ackedAt && (
            <Pressable onPress={() => void act(item.id, { acked_at: now, read_at: now })} accessibilityRole="button" style={{ padding: 8 }}>
              <Text style={{ color: theme.primary, fontWeight: '600' }}>{t('notif.ack')}</Text>
            </Pressable>
          )}
        </Pressable>
      );
    }} />
  );
}

function useMe() { return useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')) }); }

function Home({ theme }: { theme: Theme }) {
  const s = styles(theme);
  const me = useMe().data;
  return (
    <View>
      <Text style={s.h1}>{me ? t('home.greeting', { partOfDay: 'day', name: me.name.split(' ')[0] ?? '' }) : t('common.loading')}</Text>
      <Text style={s.muted}>{me?.firmName}</Text>
    </View>
  );
}

function More({ theme, onRegisters, onCollections, onHr, onOpen }: { theme: Theme; onRegisters(): void; onCollections(): void; onHr(): void; onOpen(x: 'chat' | 'calendar' | 'appointments' | 'practice'): void }) {
  const s = styles(theme);
  const qcl = useQueryClient();
  const setTokens = useSession((x) => x.setTokens);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => unwrap(api.GET('/auth/sessions')) });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/auth/sessions/{id}/revoke', { params: { path: { id } } })),
    onSuccess: () => qcl.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const active = useMemo(() => (sessions.data ?? []).filter((x) => !x.revokedAt), [sessions.data]);
  const billing = useBillingPerms().view;
  const unread = useChatUnread();
  return (
    <View style={{ flex: 1 }}>
      {([['chat', 'message-square', 'm.chat.title'], ['calendar', 'calendar', 'm.cal.title'], ['appointments', 'user-check', 'm.cal.appointments']] as const).map(([k, icon, label]) => (
        <Pressable key={k} style={[s.row, { minHeight: 48 }]} onPress={() => onOpen(k)} accessibilityRole="button">
          <Feather name={icon} size={18} color={theme.primary} style={{ marginRight: 10 }} />
          <Text style={[s.text, { flex: 1 }]}>{t(label)}</Text>
          {k === 'chat' && unread > 0 && <Text style={{ color: theme.primaryText, backgroundColor: theme.primary, borderRadius: 10, paddingHorizontal: 8, overflow: 'hidden', marginRight: 6 }}>{unread}</Text>}
          <Feather name="chevron-right" size={18} color={theme.textMuted} />
        </Pressable>
      ))}
      <Pressable style={[s.row, { minHeight: 48 }]} onPress={() => onOpen('practice')} accessibilityRole="button">
        <Feather name="file-text" size={18} color={theme.primary} style={{ marginRight: 10 }} />
        <Text style={[s.text, { flex: 1 }]}>{t('m.notice.hub')}</Text>
        <Feather name="chevron-right" size={18} color={theme.textMuted} />
      </Pressable>
      {billing && <Pressable style={[s.row, { minHeight: 48 }]} onPress={onCollections} accessibilityRole="button">
        <Feather name="credit-card" size={18} color={theme.primary} style={{ marginRight: 10 }} />
        <Text style={[s.text, { flex: 1 }]}>{t('m.bill.collections')}</Text>
        <Feather name="chevron-right" size={18} color={theme.textMuted} />
      </Pressable>}
      <Pressable style={[s.row, { minHeight: 48 }]} onPress={onHr} accessibilityRole="button">
        <Feather name="clock" size={18} color={theme.primary} style={{ marginRight: 10 }} />
        <Text style={[s.text, { flex: 1 }]}>{t('m.time.hub')}</Text>
        <Feather name="chevron-right" size={18} color={theme.textMuted} />
      </Pressable>
      <Pressable style={[s.row, { minHeight: 48 }]} onPress={onRegisters} accessibilityRole="button">
        <Feather name="book" size={18} color={theme.primary} style={{ marginRight: 10 }} />
        <Text style={[s.text, { flex: 1 }]}>{t('m.reg.title')}</Text>
        <Feather name="chevron-right" size={18} color={theme.textMuted} />
      </Pressable>
      <Text style={[s.h2, { marginTop: 16 }]}>{t('security.sessions')}</Text>
      <FlatList data={active} keyExtractor={(x) => x.id} renderItem={({ item }) => (
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.text}>{item.label ?? item.platform}{item.current ? ` · ${t('security.thisDevice')}` : ''}</Text>
            <Text style={s.muted}>{t('security.lastSeen', { when: item.lastSeenAt ? relativeTime(item.lastSeenAt) : t('common.never') })}</Text>
          </View>
          {!item.current && <Pressable onPress={() => Alert.alert(t('security.revoke'), item.label ?? item.platform, [
            { text: t('common.cancel'), style: 'cancel' }, { text: t('security.revoke'), style: 'destructive', onPress: () => revoke.mutate(item.id) }])}>
            <Text style={{ color: theme.status.overdue }}>{t('security.revoke')}</Text>
          </Pressable>}
        </View>
      )} />
      <Pressable style={s.button} onPress={() => void unwrap(api.POST('/notifications/test')).catch(() => undefined)} accessibilityRole="button">
        <Text style={s.buttonText}>{t('notif.sendTest')}</Text>
      </Pressable>
      <Pressable style={s.button} onPress={async () => { await api.POST('/auth/logout').catch(() => undefined); await stopSync(true); setTokens(null); }} accessibilityRole="button">
        <Text style={s.buttonText}>{t('common.signOut')}</Text>
      </Pressable>
    </View>
  );
}

const styles = (th: Theme) => StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', padding: 24, gap: 4 },
  h1: { fontSize: 22, fontWeight: '600', color: th.text },
  h2: { fontSize: 17, fontWeight: '600', color: th.text, marginBottom: 8 },
  text: { fontSize: 15, color: th.text },
  muted: { fontSize: 13, color: th.textMuted },
  label: { fontSize: 13, color: th.textMuted, marginTop: 12 },
  input: { borderWidth: 1, borderColor: th.border, backgroundColor: th.surface, color: th.text, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  alert: { marginTop: 12, padding: 8, borderRadius: 6, backgroundColor: th.surfaceAlt, color: th.text },
  button: { marginTop: 20, backgroundColor: th.primary, borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: th.primaryText, fontWeight: '600', fontSize: 15 },
  tabbar: { flexDirection: 'row', borderTopWidth: 1, borderColor: th.border, backgroundColor: th.surface },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8, minHeight: 48 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: th.border },
});
