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
import { themeFor, type Theme } from './theme';

const t = createTranslator('en-IN', { product: PRODUCT.name });
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

export function App() {
  const theme = themeFor(useColorScheme());
  const { tokens, ready, init } = useSession();
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { if (!tokens) qc.clear(); }, [tokens]);
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
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, padding: 16 }}>
        {tab === 'home' ? <Home theme={theme} /> : tab === 'more' ? <More theme={theme} />
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

function More({ theme }: { theme: Theme }) {
  const s = styles(theme);
  const qcl = useQueryClient();
  const setTokens = useSession((x) => x.setTokens);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => unwrap(api.GET('/auth/sessions')) });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/auth/sessions/{id}/revoke', { params: { path: { id } } })),
    onSuccess: () => qcl.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const active = useMemo(() => (sessions.data ?? []).filter((x) => !x.revokedAt), [sessions.data]);
  return (
    <View style={{ flex: 1 }}>
      <Text style={s.h2}>{t('security.sessions')}</Text>
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
      <Pressable style={s.button} onPress={async () => { await api.POST('/auth/logout').catch(() => undefined); setTokens(null); }} accessibilityRole="button">
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
