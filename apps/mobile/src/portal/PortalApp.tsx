import { Feather } from '@expo/vector-icons';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMM_CHANNELS, formatINR, PROFILE_FIELDS, type PortalGrants } from '@worko/domain';
import { relativeTime, type MessageKey } from '@worko/i18n';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, Image, Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import {
  accentColor, cacheView, canVerify, heldSecondsLeft, initialOtp, invoiceDisplay, isHeld, moreItems, otpEventFor, otpReducer, parseGrants, pickClient, portalTabs,
  profileChanges, resendIn, toPortalInvoice, totalOutstanding, validCode, validFirm, validIdentifier, type CacheEntry, type OtpEvent, type OtpState, type PortalTab,
} from '../logic/portal';
import { currentFy } from '../logic/registers';
import { pickImage } from '../picker';
import { Header } from '../screens/Header';
import { palette } from '@worko/ui-tokens';
import type { Theme } from '../theme';
import { t, ui } from '../ui';
import {
  loadCache, logoUrl, openExternal, openPortalDocument, openPortalInvoicePdf, pget, portalLogout, portalRespond, portalUpload, ppublic, psend, saveCache,
  usePortal, type HttpError, type PortalTokens,
} from './session';

type Branding = { firm: string; displayName: string; accent: string; logoUrl: string | null; supportEmail: string | null; supportPhone: string | null; welcomeText: string | null };
type Me = { user: { id: string; name: string | null; email: string | null; phone: string | null }; clients: Array<{ id: string; name: string; grants: unknown }>; branding: Branding };
type RNFile = { uri: string; name: string; type: string };

/** Portal mode gets its own query cache so nothing from a staff session can ever be shown here (and vice versa). */
const pqc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
const errText = (e: unknown) => (e as HttpError)?.message ?? t('common.error');

export function portalTheme(theme: Theme, accent: string | undefined): Theme {
  const primary = accentColor(accent, theme.name);
  return { ...theme, primary, primaryText: theme.name === 'dark' ? palette.dark.bg : palette.light.surface } as Theme;
}

/** Root of portal mode. `onStaff` returns to the staff login (portal tokens untouched until sign-out). */
export function PortalRoot({ theme, onStaff }: { theme: Theme; onStaff(): void }) {
  const { tokens, ready, init } = usePortal();
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { if (!tokens) pqc.clear(); }, [tokens]);
  if (!ready) return <ActivityIndicator style={{ flex: 1 }} />;
  return (
    <QueryClientProvider client={pqc}>
      {tokens ? <PortalTabs theme={theme} /> : <PortalLogin theme={theme} onStaff={onStaff} />}
    </QueryClientProvider>
  );
}

// ---------------- Login: firm → branding → OTP ----------------

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return now;
}

const OTP_MSG: Record<NonNullable<OtpState['error']>, MessageKey> = {
  identifier: 'm.portal.err.identifier', code: 'm.portal.err.code', invalid: 'm.portal.err.invalid', codeSpent: 'm.portal.err.codeSpent',
  rateLimited: 'm.portal.err.rateLimited', network: 'm.portal.err.network',
};

function PortalLogin({ theme: base, onStaff }: { theme: Theme; onStaff(): void }) {
  const { firm: savedFirm, setFirm, setTokens } = usePortal();
  const [firm, setFirmText] = useState(savedFirm ?? '');
  const [branding, setBranding] = useState<Branding | null>(null);
  const [firmErr, setFirmErr] = useState<MessageKey | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [otp, dispatchRaw] = useReducer((s: OtpState, a: { e: OtpEvent; now: number }) => otpReducer(s, a.e, a.now), undefined, initialOtp);
  const dispatch = (e: OtpEvent) => dispatchRaw({ e, now: Date.now() });
  const now = useNow();
  const theme = portalTheme(base, branding?.accent);
  const s = ui(theme);

  async function loadBranding(f = firm) {
    const slug = f.trim().toLowerCase();
    if (!validFirm(slug)) { setFirmErr('m.portal.err.firm'); return; }
    setBusy(true); setFirmErr(null);
    try { const b = await ppublic<Branding>('GET', `/portal/branding/${encodeURIComponent(slug)}`); setBranding(b); setFirm(slug); }
    catch (e) { setFirmErr((e as HttpError).status === 404 ? 'm.portal.err.firmUnknown' : 'm.portal.err.network'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (savedFirm) void loadBranding(savedFirm); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function request() {
    if (!validIdentifier(identifier)) { dispatch({ type: 'badInput', field: 'identifier' }); return; }
    setBusy(true);
    try { await ppublic('POST', '/portal/auth/otp/request', { firm: branding!.firm, identifier: identifier.trim() }); dispatch({ type: 'sent' }); }
    catch (e) { dispatch(otpEventFor('request', (e as HttpError).status)); }
    finally { setBusy(false); }
  }
  async function verify() {
    if (!validCode(code)) { dispatch({ type: 'badInput', field: 'code' }); return; }
    setBusy(true);
    try {
      const tk = await ppublic<PortalTokens>('POST', '/portal/auth/otp/verify', { firm: branding!.firm, identifier: identifier.trim(), code: code.trim(), device: { platform: 'android', label: 'Android' } });
      setTokens(tk);
    } catch (e) { dispatch(otpEventFor('verify', (e as HttpError).status)); setCode(''); }
    finally { setBusy(false); }
  }

  const held = isHeld(otp, now);
  const verifyOk = canVerify(otp, now);
  const wait = resendIn(otp, now);
  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 4, flexGrow: 1, justifyContent: 'center' }} keyboardShouldPersistTaps="handled">
      {branding?.logoUrl && <Image source={{ uri: logoUrl(branding.firm) }} style={{ width: 120, height: 48, resizeMode: 'contain' }} accessibilityIgnoresInvertColors accessibilityLabel={branding.displayName} />}
      <Text style={s.h1} accessibilityRole="header">{branding?.displayName ?? t('m.portal.title')}</Text>
      <Text style={s.muted}>{branding?.welcomeText ?? t('m.portal.subtitle')}</Text>
      {!branding ? <>
        {firmErr && <Text accessibilityRole="alert" style={s.alert}>{t(firmErr)}</Text>}
        <Text style={s.label}>{t('m.portal.firmCode')}</Text>
        <TextInput style={s.input} value={firm} onChangeText={setFirmText} autoCapitalize="none" autoCorrect={false} placeholder={t('auth.firmHint')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.portal.firmCode')} />
        <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void loadBranding()} accessibilityRole="button"><Text style={s.buttonText}>{t('m.portal.continue')}</Text></Pressable>
      </> : <>
        {otp.error && <Text accessibilityRole="alert" style={s.alert}>{otp.error === 'rateLimited' && held ? t('m.portal.err.heldFor', { seconds: heldSecondsLeft(otp, now) }) : t(OTP_MSG[otp.error])}</Text>}
        {otp.phase === 'code' && !otp.error && <Text accessibilityRole="alert" style={s.alert}>{t('m.portal.sentNeutral')}</Text>}
        <Text style={s.label}>{t('m.portal.identifier')}</Text>
        <TextInput style={s.input} value={identifier} editable={otp.phase === 'identify'} onChangeText={setIdentifier} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
          placeholder={t('m.portal.identifierHint')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.portal.identifier')} />
        {otp.phase === 'code' && <>
          <Text style={s.label}>{t('auth.otp')}</Text>
          <TextInput style={s.input} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} accessibilityLabel={t('auth.otp')} />
        </>}
        {otp.phase === 'code' && !verifyOk && !held && otp.error !== 'codeSpent' && <Text style={s.alert}>{t('m.portal.err.expired')}</Text>}
        <Pressable style={[s.button, (busy || held || (otp.phase === 'code' && !verifyOk)) && { opacity: 0.5 }]} disabled={busy || held || (otp.phase === 'code' && !verifyOk)} onPress={() => void (otp.phase === 'identify' ? request() : verify())} accessibilityRole="button">
          {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={s.buttonText}>{otp.phase === 'identify' ? t('auth.sendOtp') : t('auth.signIn')}</Text>}
        </Pressable>
        {otp.phase === 'code' && <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <Pressable style={[s.ghost, { flex: 1 }, (wait > 0 || busy) && { opacity: 0.5 }]} disabled={wait > 0 || busy} onPress={() => void request()} accessibilityRole="button">
            <Text style={s.ghostText}>{wait > 0 ? t('m.portal.resendIn', { seconds: wait }) : t('m.portal.resend')}</Text></Pressable>
          <Pressable style={[s.ghost, { flex: 1 }]} onPress={() => { dispatch({ type: 'edit' }); setCode(''); }} accessibilityRole="button"><Text style={s.ghostText}>{t('m.portal.changeId')}</Text></Pressable>
        </View>}
        <Pressable style={[s.ghost, { marginTop: 8 }]} onPress={() => { setBranding(null); dispatch({ type: 'edit' }); }} accessibilityRole="button"><Text style={s.ghostText}>{t('m.portal.changeFirm')}</Text></Pressable>
      </>}
      <Pressable style={{ minHeight: 48, justifyContent: 'center', marginTop: 16 }} onPress={onStaff} accessibilityRole="button"><Text style={{ color: theme.primary, textAlign: 'center' }}>{t('m.portal.staffLogin')}</Text></Pressable>
    </ScrollView>
  );
}

// ---------------- Signed-in shell ----------------

const TAB_META: Record<PortalTab, { label: MessageKey; icon: 'home' | 'folder' | 'inbox' | 'file-text' | 'message-circle' | 'menu' }> = {
  home: { label: 'm.portal.tab.home', icon: 'home' }, documents: { label: 'm.portal.tab.documents', icon: 'folder' }, requests: { label: 'm.portal.tab.requests', icon: 'inbox' },
  invoices: { label: 'm.portal.tab.invoices', icon: 'file-text' }, messages: { label: 'm.portal.tab.messages', icon: 'message-circle' }, more: { label: 'm.portal.tab.more', icon: 'menu' },
};

function useMe() { return useQuery({ queryKey: ['portal', 'me'], queryFn: () => pget<Me>('/portal/me') }); }

function PortalTabs({ theme: base }: { theme: Theme }) {
  const me = useMe();
  const { clientId, setClient } = usePortal();
  const clients = useMemo(() => (me.data?.clients ?? []).map((c) => ({ ...c, grants: parseGrants(c.grants) })), [me.data]);
  useEffect(() => { const next = pickClient(clients, clientId); if (next !== clientId) setClient(next); }, [clients, clientId, setClient]);
  const theme = portalTheme(base, me.data?.branding.accent);
  const s = ui(theme);
  const client = clients.find((c) => c.id === clientId);
  const tabs = useMemo(() => (client ? portalTabs(client.grants) : (['home', 'more'] as PortalTab[])), [client]);
  const [tab, setTab] = useState<PortalTab>('home');
  const [sub, setSub] = useState<'esign' | 'receipts' | 'profile' | 'consent' | 'switch' | null>(null);
  useEffect(() => { if (!tabs.includes(tab)) setTab('home'); }, [tabs, tab]);
  useEffect(() => { const h = BackHandler.addEventListener('hardwareBackPress', () => { if (sub) { setSub(null); return true; } return false; }); return () => h.remove(); }, [sub]);

  if (me.isLoading) return <ActivityIndicator style={{ flex: 1 }} />;
  if (me.error && !me.data) return <View style={{ padding: 16 }}><Text style={s.alert}>{t('m.portal.offlineNoCache')}</Text>
    <Pressable style={s.button} onPress={() => void me.refetch()} accessibilityRole="button"><Text style={s.buttonText}>{t('m.portal.retry')}</Text></Pressable>
    <Pressable style={s.ghost} onPress={() => void portalLogout()} accessibilityRole="button"><Text style={s.ghostText}>{t('common.signOut')}</Text></Pressable></View>;
  const ownerKey = `${clientId ?? ''}`;
  return (
    <View style={{ flex: 1 }}>
      <Pressable style={{ flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderColor: theme.border, minHeight: 48 }}
        onPress={() => clients.length > 1 && setSub('switch')} accessibilityRole="button" accessibilityLabel={t('m.portal.switchClient')}>
        <View style={{ flex: 1 }}>
          <Text style={[s.muted, { color: theme.primary }]}>{me.data?.branding.displayName}</Text>
          <Text style={s.text} numberOfLines={1}>{client?.name ?? t('m.portal.noClients')}</Text>
        </View>
        {clients.length > 1 && <Feather name="chevron-down" size={18} color={theme.textMuted} />}
      </Pressable>
      <View style={{ flex: 1, padding: 16 }}>
        {!client ? <Text style={s.muted}>{t('m.portal.noClients')}</Text>
          : sub === 'switch' ? <ClientSwitcher theme={theme} clients={clients} current={clientId} onPick={(id) => { setClient(id); setSub(null); setTab('home'); }} onBack={() => setSub(null)} />
          : sub === 'esign' ? <Esign key={ownerKey} theme={theme} clientId={client.id} onBack={() => setSub(null)} />
          : sub === 'receipts' ? <Receipts key={ownerKey} theme={theme} clientId={client.id} onBack={() => setSub(null)} />
          : sub === 'profile' ? <Profile theme={theme} clientId={client.id} onBack={() => setSub(null)} />
          : sub === 'consent' ? <Consent theme={theme} clientId={client.id} onBack={() => setSub(null)} />
          : tab === 'home' ? <Dashboard key={ownerKey} theme={theme} clientId={client.id} grants={client.grants} onOpen={setTab} />
          : tab === 'documents' ? <Documents key={ownerKey} theme={theme} clientId={client.id} />
          : tab === 'requests' ? <Requests key={ownerKey} theme={theme} clientId={client.id} canAttach={client.grants.documents.enabled} />
          : tab === 'invoices' ? <Invoices key={ownerKey} theme={theme} clientId={client.id} canPay={client.grants.payments} />
          : tab === 'messages' ? <Messages key={ownerKey} theme={theme} clientId={client.id} />
          : <MoreMenu theme={theme} grants={client.grants} onOpen={setSub} branding={me.data?.branding} />}
      </View>
      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }} accessibilityRole="tablist">
        {tabs.map((k) => (
          <Pressable key={k} style={{ flex: 1, alignItems: 'center', paddingVertical: 8, minHeight: 48 }} onPress={() => { setSub(null); setTab(k); }} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
            <Feather name={TAB_META[k].icon} size={20} color={tab === k ? theme.primary : theme.textMuted} />
            <Text style={{ fontSize: 11, color: tab === k ? theme.primary : theme.textMuted }}>{t(TAB_META[k].label)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ClientSwitcher({ theme, clients, current, onPick, onBack }: { theme: Theme; clients: Array<{ id: string; name: string }>; current: string | null; onPick(id: string): void; onBack(): void }) {
  const s = ui(theme);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.portal.switchClient')} onBack={onBack} />
      <FlatList data={clients} keyExtractor={(c) => c.id} renderItem={({ item }) => (
        <Pressable style={s.row} onPress={() => onPick(item.id)} accessibilityRole="radio" accessibilityState={{ checked: item.id === current }}>
          <Text style={[s.text, { flex: 1 }]}>{item.name}</Text>
          {item.id === current && <Feather name="check" size={18} color={theme.primary} />}
        </Pressable>
      )} />
    </View>
  );
}

/** Live data wins; on failure falls back to the last saved copy with a clearly marked stale banner. */
function useCached<T>(name: 'dashboard' | 'documents', clientId: string, path: string) {
  const q = useQuery({ queryKey: ['portal', name, clientId], queryFn: () => pget<T>(path) });
  const [cached, setCached] = useState<CacheEntry<T> | null>(null);
  useEffect(() => { void loadCache<T>(name, clientId).then(setCached); }, [name, clientId]);
  useEffect(() => { if (q.data !== undefined) void saveCache(name, clientId, q.data); }, [q.data, name, clientId]);
  const v = cacheView(q.data, cached, !!q.error, Date.now());
  return { ...v, q };
}

function StaleBanner({ theme, savedAt }: { theme: Theme; savedAt: number | null }) {
  if (!savedAt) return null;
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 8, borderRadius: 6, backgroundColor: theme.surfaceAlt, marginBottom: 8 }}>
      <Feather name="wifi-off" size={14} color={theme.text} />
      <Text style={{ color: theme.text, fontSize: 13, flex: 1 }}>{t('m.portal.stale', { when: relativeTime(new Date(savedAt).toISOString()) })}</Text>
    </View>
  );
}

type Dash = {
  pendingRequests?: Array<{ kind: string; id: string; title: string; dueDate: string | null }>;
  outstanding?: { totalPaise: number; invoices: Array<Record<string, unknown>> };
  recentDocuments?: Array<{ id: string; name: string; category: string; createdAt: string }>;
  upcomingDueDates?: Array<{ title: string; periodLabel: string | null; dueDate: string }>;
  pendingSignatures?: number;
};

function Dashboard({ theme, clientId, grants, onOpen }: { theme: Theme; clientId: string; grants: PortalGrants; onOpen(t: PortalTab): void }) {
  const s = ui(theme);
  const { data, stale, savedAt, q } = useCached<Dash>('dashboard', clientId, `/portal/clients/${clientId}/dashboard`);
  const out = data?.outstanding ? totalOutstanding(data.outstanding.invoices.map((i) => toPortalInvoice({ kind: 'invoice', status: 'issued', ...i }))) : null;
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}>
      {stale && <StaleBanner theme={theme} savedAt={savedAt} />}
      {!data && q.isLoading && <ActivityIndicator />}
      {!data && q.error && <Text style={s.alert}>{t('m.portal.offlineNoCache')}</Text>}
      {out && <Pressable style={[s.row, { minHeight: 64 }]} onPress={() => onOpen('invoices')} accessibilityRole="button">
        <View style={{ flex: 1 }}><Text style={s.muted}>{t('m.portal.outstanding')}</Text><Text style={s.h1}>{formatINR(out.totalPaise)}</Text>
          {out.overduePaise > 0 && <Text style={{ color: theme.status.overdue }}>{t('m.portal.overdueAmt', { amount: formatINR(out.overduePaise) })}</Text>}</View>
        <Feather name="chevron-right" size={18} color={theme.textMuted} />
      </Pressable>}
      {data?.pendingRequests && <>
        <Text style={s.h2}>{t('m.portal.pendingRequests', { count: data.pendingRequests.length })}</Text>
        {data.pendingRequests.slice(0, 5).map((r) => (
          <Pressable key={r.kind + r.id} style={s.row} onPress={() => onOpen('requests')} accessibilityRole="button">
            <Text style={[s.text, { flex: 1 }]}>{r.title}</Text>{r.dueDate && <Text style={s.muted}>{String(r.dueDate).slice(0, 10)}</Text>}
          </Pressable>
        ))}
      </>}
      {!!data?.pendingSignatures && <Text style={s.alert}>{t('m.portal.pendingSignatures', { count: data.pendingSignatures })}</Text>}
      {data?.recentDocuments && grants.documents.enabled && <>
        <Text style={s.h2}>{t('m.portal.recentDocs')}</Text>
        {data.recentDocuments.length === 0 && <Text style={s.muted}>{t('m.portal.noDocs')}</Text>}
        {data.recentDocuments.map((d) => (
          <Pressable key={d.id} style={s.row} onPress={() => onOpen('documents')} accessibilityRole="button">
            <Feather name="file" size={16} color={theme.textMuted} style={{ marginRight: 8 }} /><Text style={[s.text, { flex: 1 }]} numberOfLines={1}>{d.name}</Text><Text style={s.muted}>{d.category}</Text>
          </Pressable>
        ))}
      </>}
      {data?.upcomingDueDates && <>
        <Text style={s.h2}>{t('m.portal.dueDates')}</Text>
        {data.upcomingDueDates.map((d, i) => <View key={i} style={s.row}><Text style={[s.text, { flex: 1 }]}>{d.title}{d.periodLabel ? ` · ${d.periodLabel}` : ''}</Text><Text style={s.muted}>{String(d.dueDate).slice(0, 10)}</Text></View>)}
      </>}
    </ScrollView>
  );
}

type Doc = { id: string; name: string; category: string; fy: string | null; size: number; createdAt: string; fromClient: boolean };

function Documents({ theme, clientId }: { theme: Theme; clientId: string }) {
  const s = ui(theme);
  const { data, stale, savedAt, q } = useCached<Doc[]>('documents', clientId, `/portal/clients/${clientId}/documents`);
  const [upload, setUpload] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (upload) return <PortalUpload theme={theme} clientId={clientId} onDone={(m) => { setUpload(false); setMsg(m); void q.refetch(); }} onBack={() => setUpload(false)} />;
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.portal.tab.documents')} right={<Pressable style={s.ghost} onPress={() => setUpload(true)} disabled={stale} accessibilityRole="button"><Feather name="upload" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.portal.upload')}</Text></Pressable>} />
      {stale && <StaleBanner theme={theme} savedAt={savedAt} />}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <FlatList data={data ?? []} keyExtractor={(d) => d.id} refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}
        ListEmptyComponent={<Text style={s.muted}>{q.isLoading ? t('common.loading') : q.error && !data ? t('m.portal.offlineNoCache') : t('m.portal.noDocs')}</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.row} disabled={stale} onPress={() => void openPortalDocument(clientId, item.id).catch((e) => setMsg(errText(e)))} accessibilityRole="button" accessibilityHint={t('m.portal.open')}>
            <Feather name={item.fromClient ? 'upload-cloud' : 'file'} size={18} color={theme.textMuted} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.text} numberOfLines={2}>{item.name}</Text>
              <Text style={s.muted}>{[item.category, item.fy, item.fromClient ? t('m.portal.fromYou') : null].filter(Boolean).join(' · ')}</Text>
            </View>
            <Feather name="download" size={18} color={stale ? theme.textMuted : theme.primary} />
          </Pressable>
        )} />
    </View>
  );
}

async function pickFile(src: 'camera' | 'library', setMsg: (m: string) => void): Promise<RNFile | null> {
  const r = await pickImage(src);
  if (r === 'denied') { setMsg(t('m.doc.noPermission')); const lib = await pickImage('library'); return lib && lib !== 'denied' ? lib : null; }
  return r;
}

function PortalUpload({ theme, clientId, onDone, onBack }: { theme: Theme; clientId: string; onDone(msg: string): void; onBack(): void }) {
  const s = ui(theme);
  const [file, setFile] = useState<RNFile | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [fy, setFy] = useState(currentFy());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fyOk = !fy || /^\d{4}-\d{2}$/.test(fy);
  async function send() {
    if (!file) return;
    setBusy(true); setMsg(null);
    try { await portalUpload(clientId, file, { name: name.trim() || undefined, fy: fy || undefined, note: note.trim() || undefined }); onDone(t('m.portal.uploaded')); }
    catch (e) { setMsg(t('m.doc.uploadFailed', { reason: errText(e) })); } finally { setBusy(false); }
  }
  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <Header theme={theme} title={t('m.portal.upload')} onBack={onBack} />
      <Text style={s.muted}>{t('m.portal.uploadHint')}</Text>
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {!file ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Pressable style={[s.button, { flex: 1 }]} onPress={() => void pickFile('camera', setMsg).then((f) => { if (f) { setFile(f); setName(f.name); } })} accessibilityRole="button"><Text style={s.buttonText}>{t('m.doc.camera')}</Text></Pressable>
        <Pressable style={[s.button, { flex: 1 }]} onPress={() => void pickFile('library', setMsg).then((f) => { if (f) { setFile(f); setName(f.name); } })} accessibilityRole="button"><Text style={s.buttonText}>{t('m.doc.library')}</Text></Pressable>
      </View> : <View>
        <Image source={{ uri: file.uri }} style={{ width: '100%', height: 220, resizeMode: 'contain', marginTop: 12, backgroundColor: theme.surfaceAlt }} accessibilityIgnoresInvertColors />
        <Pressable style={[s.ghost, { marginTop: 8, alignSelf: 'flex-start' }]} onPress={() => setFile(null)} accessibilityRole="button"><Text style={s.ghostText}>{t('m.doc.retake')}</Text></Pressable>
        <Text style={s.label}>{t('m.doc.name')}</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} accessibilityLabel={t('m.doc.name')} />
        <Text style={s.label}>{t('m.doc.fy')}</Text>
        <TextInput style={s.input} value={fy} onChangeText={setFy} placeholder="2026-27" placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.doc.fy')} />
        <Text style={s.label}>{t('m.portal.note')}</Text>
        <TextInput style={s.input} value={note} onChangeText={setNote} maxLength={500} accessibilityLabel={t('m.portal.note')} />
        <Pressable style={[s.button, (busy || !fyOk) && { opacity: 0.5 }]} disabled={busy || !fyOk} onPress={() => void send()} accessibilityRole="button">
          {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={s.buttonText}>{t('m.doc.upload')}</Text>}
        </Pressable>
      </View>}
    </ScrollView>
  );
}

type Req = { kind: 'pbc' | 'task'; id: string; title: string; description?: string | null; issue?: string | null; dueDate: string | null; status?: string; rejectionReason?: string | null };

function Requests({ theme, clientId, canAttach }: { theme: Theme; clientId: string; canAttach: boolean }) {
  const s = ui(theme);
  const q = useQuery({ queryKey: ['portal', 'requests', clientId], queryFn: () => pget<Req[]>(`/portal/clients/${clientId}/requests`) });
  const [open, setOpen] = useState<Req | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (open) return <Respond theme={theme} clientId={clientId} req={open} canAttach={canAttach} onBack={() => setOpen(null)} onDone={() => { setOpen(null); setMsg(t('m.portal.responded')); void q.refetch(); }} />;
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.portal.tab.requests')} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {q.error && <Text style={s.alert}>{errText(q.error)}</Text>}
      <FlatList data={q.data ?? []} keyExtractor={(r) => r.kind + r.id} refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}
        ListEmptyComponent={<Text style={s.muted}>{q.isLoading ? t('common.loading') : t('m.portal.noRequests')}</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => setOpen(item)} accessibilityRole="button">
            <View style={{ flex: 1 }}>
              <Text style={s.text}>{item.title}</Text>
              {!!(item.issue ?? item.description) && <Text style={s.muted} numberOfLines={2}>{item.issue ?? item.description}</Text>}
              {item.status === 'rejected' && <Text style={{ color: theme.status.overdue, fontSize: 13 }}>{t('m.portal.rejected', { reason: item.rejectionReason ?? '' })}</Text>}
            </View>
            {item.dueDate && <Text style={s.muted}>{String(item.dueDate).slice(0, 10)}</Text>}
          </Pressable>
        )} />
    </View>
  );
}

function Respond({ theme, clientId, req, canAttach, onBack, onDone }: { theme: Theme; clientId: string; req: Req; canAttach: boolean; onBack(): void; onDone(): void }) {
  const s = ui(theme);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<RNFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function send() {
    if (!message.trim() && !file) { setMsg(t('m.portal.emptyResponse')); return; }
    setBusy(true); setMsg(null);
    try { await portalRespond(clientId, req.kind, req.id, message, file); onDone(); } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  }
  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <Header theme={theme} title={req.title} onBack={onBack} />
      {!!(req.issue ?? req.description) && <Text style={s.text}>{req.issue ?? req.description}</Text>}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Text style={s.label}>{t('m.portal.yourReply')}</Text>
      <TextInput style={[s.input, { minHeight: 96, textAlignVertical: 'top', paddingTop: 10 }]} multiline value={message} onChangeText={setMessage} maxLength={5000} accessibilityLabel={t('m.portal.yourReply')} />
      {canAttach && (file ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <Image source={{ uri: file.uri }} style={{ width: 64, height: 64, borderRadius: 4 }} accessibilityIgnoresInvertColors />
        <Pressable style={s.ghost} onPress={() => setFile(null)} accessibilityRole="button"><Text style={s.ghostText}>{t('m.portal.removePhoto')}</Text></Pressable>
      </View> : <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Pressable style={[s.ghost, { flex: 1 }]} onPress={() => void pickFile('camera', setMsg).then((f) => f && setFile(f))} accessibilityRole="button"><Feather name="camera" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.doc.camera')}</Text></Pressable>
        <Pressable style={[s.ghost, { flex: 1 }]} onPress={() => void pickFile('library', setMsg).then((f) => f && setFile(f))} accessibilityRole="button"><Feather name="image" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.doc.library')}</Text></Pressable>
      </View>)}
      <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void send()} accessibilityRole="button">
        {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={s.buttonText}>{t('m.portal.sendReply')}</Text>}
      </Pressable>
    </ScrollView>
  );
}

const BADGE: Record<ReturnType<typeof invoiceDisplay>['badge'], MessageKey> = { paid: 'm.portal.inv.paid', overdue: 'm.portal.inv.overdue', due: 'm.portal.inv.due', credit: 'm.portal.inv.credit' };

function Invoices({ theme, clientId, canPay }: { theme: Theme; clientId: string; canPay: boolean }) {
  const s = ui(theme);
  const q = useQuery({ queryKey: ['portal', 'invoices', clientId], queryFn: () => pget<Array<Record<string, unknown>>>(`/portal/clients/${clientId}/invoices`) });
  const list = useMemo(() => (q.data ?? []).map(toPortalInvoice), [q.data]);
  const tot = totalOutstanding(list);
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <InvoiceView theme={theme} clientId={clientId} id={open} canPay={canPay} onBack={() => setOpen(null)} />;
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.portal.tab.invoices')} />
      {q.error && <Text style={s.alert}>{errText(q.error)}</Text>}
      <Text style={s.muted}>{t('m.portal.outstanding')}: {formatINR(tot.totalPaise)}{tot.overduePaise ? ` · ${t('m.portal.overdueAmt', { amount: formatINR(tot.overduePaise) })}` : ''}</Text>
      <FlatList data={list} keyExtractor={(i) => i.id} refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}
        ListEmptyComponent={<Text style={s.muted}>{q.isLoading ? t('common.loading') : t('m.portal.noInvoices')}</Text>}
        renderItem={({ item }) => { const d = invoiceDisplay(item); return (
          <Pressable style={s.row} onPress={() => setOpen(item.id)} accessibilityRole="button">
            <View style={{ flex: 1 }}><Text style={s.text}>{item.number ?? '—'}</Text><Text style={s.muted}>{item.issueDate}{item.dueDate ? ` · ${t('m.portal.dueOn', { date: item.dueDate })}` : ''}</Text></View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.text}>{formatINR(d.badge === 'paid' || d.badge === 'credit' ? item.totalPaise : d.outstandingPaise)}</Text>
              <Text style={[s.chip, d.badge === 'overdue' && { color: theme.status.overdue }]}>{d.badge === 'overdue' ? t('m.portal.inv.overdueDays', { days: d.daysOverdue }) : t(BADGE[d.badge])}</Text>
            </View>
          </Pressable>
        ); }} />
    </View>
  );
}

type InvDetail = { id: string; number: string | null; status: string; issueDate: string | null; dueDate: string | null; totalPaise: number; balancePaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  lines: Array<{ description: string; totalPaise: number }>; payable: boolean; paymentUrl: string | null };

function InvoiceView({ theme, clientId, id, canPay, onBack }: { theme: Theme; clientId: string; id: string; canPay: boolean; onBack(): void }) {
  const s = ui(theme);
  const q = useQuery({ queryKey: ['portal', 'invoice', clientId, id], queryFn: () => pget<InvDetail>(`/portal/clients/${clientId}/invoices/${id}`) });
  const [msg, setMsg] = useState<string | null>(null);
  const pay = useMutation({
    mutationFn: async () => { const r = await psend<{ url: string }>('POST', `/portal/clients/${clientId}/invoices/${id}/pay`); if (!(await openExternal(r.url))) throw new Error(t('m.portal.badLink')); },
    onError: (e) => setMsg((e as HttpError).status === 409 ? t('m.portal.payUnavailable') : errText(e)),
    onSuccess: () => setMsg(t('m.portal.payOpened')),
  });
  const d = q.data;
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}>
      <Header theme={theme} title={d?.number ?? t('m.portal.invoice')} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {!d ? <ActivityIndicator /> : <>
        <Text style={s.muted}>{d.issueDate}{d.dueDate ? ` · ${t('m.portal.dueOn', { date: String(d.dueDate).slice(0, 10) })}` : ''}</Text>
        {d.lines.map((l, i) => <View key={i} style={s.row}><Text style={[s.text, { flex: 1 }]}>{l.description}</Text><Text style={s.text}>{formatINR(l.totalPaise)}</Text></View>)}
        <View style={s.row}><Text style={[s.muted, { flex: 1 }]}>{t('m.portal.taxable')}</Text><Text style={s.text}>{formatINR(d.taxablePaise)}</Text></View>
        <View style={s.row}><Text style={[s.muted, { flex: 1 }]}>{t('m.portal.gst')}</Text><Text style={s.text}>{formatINR(d.cgstPaise + d.sgstPaise + d.igstPaise)}</Text></View>
        <View style={s.row}><Text style={[s.text, { flex: 1, fontWeight: '600' }]}>{t('m.portal.total')}</Text><Text style={[s.text, { fontWeight: '600' }]}>{formatINR(d.totalPaise)}</Text></View>
        <View style={s.row}><Text style={[s.text, { flex: 1 }]}>{t('m.portal.balance')}</Text><Text style={s.text}>{formatINR(d.balancePaise)}</Text></View>
        <Pressable style={s.ghost} onPress={() => void openPortalInvoicePdf(clientId, id, d.number ?? 'invoice').catch((e) => setMsg(errText(e)))} accessibilityRole="button">
          <Feather name="file-text" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.portal.pdf')}</Text></Pressable>
        {canPay && d.payable && <Pressable style={[s.button, pay.isPending && { opacity: 0.5 }]} disabled={pay.isPending} onPress={() => pay.mutate()} accessibilityRole="button">
          <Text style={s.buttonText}>{t('m.portal.pay', { amount: formatINR(d.balancePaise) })}</Text></Pressable>}
        {canPay && d.payable && <Text style={s.muted}>{t('m.portal.payHint')}</Text>}
      </>}
    </ScrollView>
  );
}

type Receipt = { id: string; number: string | null; receivedOn: string; amountPaise: number; tdsPaise: number; mode: string; allocations?: Array<{ invoiceNumber: string; amountPaise: number }> };

function Receipts({ theme, clientId, onBack }: { theme: Theme; clientId: string; onBack(): void }) {
  const s = ui(theme);
  const q = useQuery({ queryKey: ['portal', 'receipts', clientId], queryFn: () => pget<Receipt[]>(`/portal/clients/${clientId}/receipts`) });
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.portal.receipts')} onBack={onBack} />
      {q.error && <Text style={s.alert}>{errText(q.error)}</Text>}
      <FlatList data={q.data ?? []} keyExtractor={(r) => r.id} refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}
        ListEmptyComponent={<Text style={s.muted}>{q.isLoading ? t('common.loading') : t('m.portal.noReceipts')}</Text>}
        renderItem={({ item }) => (
          <View style={s.row}>
            <View style={{ flex: 1 }}><Text style={s.text}>{item.number ?? '—'} · {String(item.receivedOn).slice(0, 10)}</Text>
              <Text style={s.muted}>{(item.allocations ?? []).map((a) => a.invoiceNumber).join(', ')}{item.tdsPaise ? ` · ${t('m.portal.tds', { amount: formatINR(item.tdsPaise) })}` : ''}</Text></View>
            <Text style={s.text}>{formatINR(item.amountPaise)}</Text>
          </View>
        )} />
    </View>
  );
}

type Msg = { id: string; direction: 'in' | 'out'; subject: string | null; body: string; at: string; from: string };

function Messages({ theme, clientId }: { theme: Theme; clientId: string }) {
  const s = ui(theme);
  const qcl = useQueryClient();
  const key = ['portal', 'messages', clientId];
  const q = useQuery({ queryKey: key, queryFn: () => pget<Msg[]>(`/portal/clients/${clientId}/messages`), refetchInterval: 30_000 });
  const [body, setBody] = useState('');
  const send = useMutation({ mutationFn: (b: string) => psend('POST', `/portal/clients/${clientId}/messages`, { body: b }), onSuccess: () => { setBody(''); void qcl.invalidateQueries({ queryKey: key }); } });
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => b.at.localeCompare(a.at)), [q.data]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.portal.tab.messages')} />
      {(q.error || send.error) && <Text style={s.alert}>{errText(q.error ?? send.error)}</Text>}
      <FlatList inverted data={rows} keyExtractor={(m) => m.id} refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}
        ListEmptyComponent={<Text style={s.muted}>{q.isLoading ? t('common.loading') : t('m.portal.noMessages')}</Text>}
        renderItem={({ item }) => { const mine = item.direction === 'in'; return (
          <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', marginVertical: 4, padding: 10, borderRadius: 10, backgroundColor: mine ? theme.primary : theme.surfaceAlt }}>
            {!mine && <Text style={{ fontSize: 12, fontWeight: '600', color: theme.text }}>{item.from}</Text>}
            {!!item.subject && <Text style={{ fontSize: 12, color: mine ? theme.primaryText : theme.textMuted }}>{item.subject}</Text>}
            <Text style={{ color: mine ? theme.primaryText : theme.text, fontSize: 15 }}>{item.body}</Text>
            <Text style={{ fontSize: 11, color: mine ? theme.primaryText : theme.textMuted, marginTop: 2 }}>{relativeTime(item.at)}</Text>
          </View>
        ); }} />
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingTop: 8 }}>
        <TextInput style={[s.input, { flex: 1 }]} value={body} onChangeText={setBody} maxLength={5000} multiline placeholder={t('m.portal.typeMessage')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.portal.typeMessage')} />
        <Pressable style={[s.icon, (!body.trim() || send.isPending) && { opacity: 0.5 }]} disabled={!body.trim() || send.isPending} onPress={() => send.mutate(body.trim())} accessibilityRole="button" accessibilityLabel={t('m.portal.send')}>
          <Feather name="send" size={22} color={theme.primary} /></Pressable>
      </View>
    </View>
  );
}

function Esign({ theme, clientId, onBack }: { theme: Theme; clientId: string; onBack(): void }) {
  const s = ui(theme);
  const q = useQuery({ queryKey: ['portal', 'esign', clientId], queryFn: () => pget<Array<{ id: string; title: string; document: string; status: string; signUrl: string }>>(`/portal/clients/${clientId}/esign`) });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.portal.esign')} onBack={onBack} />
      {(msg || q.error) && <Text style={s.alert}>{msg ?? errText(q.error)}</Text>}
      <FlatList data={q.data ?? []} keyExtractor={(r) => r.id} refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}
        ListEmptyComponent={<Text style={s.muted}>{q.isLoading ? t('common.loading') : t('m.portal.noEsign')}</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => void openExternal(item.signUrl).then((ok) => !ok && setMsg(t('m.portal.badLink')))} accessibilityRole="link">
            <View style={{ flex: 1 }}><Text style={s.text}>{item.document}</Text><Text style={s.muted}>{item.title}</Text></View>
            <Text style={s.ghostText}>{t('m.portal.sign')}</Text>
          </Pressable>
        )} />
    </View>
  );
}

type ProfileData = { user: { name: string | null; email: string | null; phone: string | null }; contacts: Array<{ clientId: string; clientName: string; contactId: string | null } & Partial<Record<(typeof PROFILE_FIELDS)[number], string | null>>>;
  consent: Array<{ channel: string; address: string; status: string }>; requests: Array<{ id: string; clientId: string; fields: string[]; status: string; createdAt: string }> };

function useProfile() { return useQuery({ queryKey: ['portal', 'profile'], queryFn: () => pget<ProfileData>('/portal/profile') }); }

function Profile({ theme, clientId, onBack }: { theme: Theme; clientId: string; onBack(): void }) {
  const s = ui(theme);
  const q = useProfile();
  const contact = q.data?.contacts.find((c) => c.clientId === clientId);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  useEffect(() => { if (contact && !form) setForm(Object.fromEntries(PROFILE_FIELDS.map((f) => [f, contact[f] ?? '']))); }, [contact, form]);
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (changes: Record<string, string | null>) => psend('POST', '/portal/profile/requests', { clientId, changes }),
    onSuccess: () => { setMsg(t('m.portal.profileRequested')); void q.refetch(); }, onError: (e) => setMsg(errText(e)),
  });
  function submit() {
    if (!contact || !form) return;
    const ch = profileChanges(contact as Record<string, string | null>, form);
    if (!Object.keys(ch).length) { setMsg(t('m.portal.noChanges')); return; }
    save.mutate(ch);
  }
  const pending = (q.data?.requests ?? []).filter((r) => r.clientId === clientId && r.status === 'pending');
  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <Header theme={theme} title={t('m.portal.profile')} onBack={onBack} />
      <Text style={s.muted}>{t('m.portal.profileHint')}</Text>
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {pending.length > 0 && <Text style={s.alert}>{t('m.portal.profilePending', { count: pending.length })}</Text>}
      {!q.data ? <ActivityIndicator /> : !contact?.contactId ? <Text style={s.muted}>{t('m.portal.noContact')}</Text> : form && PROFILE_FIELDS.map((f) => (
        <View key={f}><Text style={s.label}>{t(`m.portal.field.${f}` as MessageKey)}</Text>
          <TextInput style={s.input} value={form[f]} onChangeText={(v) => setForm({ ...form, [f]: v })} maxLength={200} autoCapitalize={f === 'email' ? 'none' : 'sentences'}
            keyboardType={f === 'email' ? 'email-address' : f === 'phone' || f === 'whatsapp' ? 'phone-pad' : 'default'} accessibilityLabel={t(`m.portal.field.${f}` as MessageKey)} /></View>
      ))}
      {contact?.contactId && <Pressable style={[s.button, save.isPending && { opacity: 0.5 }]} disabled={save.isPending} onPress={submit} accessibilityRole="button"><Text style={s.buttonText}>{t('m.portal.requestChange')}</Text></Pressable>}
    </ScrollView>
  );
}

function Consent({ theme, clientId, onBack }: { theme: Theme; clientId: string; onBack(): void }) {
  const s = ui(theme);
  const q = useProfile();
  const [msg, setMsg] = useState<string | null>(null);
  const set = useMutation({
    mutationFn: (b: { channel: string; status: 'opted_in' | 'opted_out' }) => psend('PUT', '/portal/consent', { clientId, ...b }),
    onSuccess: () => { setMsg(t('m.portal.consentSaved')); void q.refetch(); }, onError: (e) => setMsg(errText(e)),
  });
  // A channel is on unless the person's own address is recorded opted out.
  const optedOut = (ch: string) => (q.data?.consent ?? []).some((c) => c.channel === ch && c.status === 'opted_out');
  return (
    <View>
      <Header theme={theme} title={t('m.portal.consent')} onBack={onBack} />
      <Text style={s.muted}>{t('m.portal.consentHint')}</Text>
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {COMM_CHANNELS.map((ch) => (
        <View key={ch} style={s.row}>
          <Text style={[s.text, { flex: 1 }]}>{t(`m.portal.channel.${ch}` as MessageKey)}</Text>
          <Switch value={!optedOut(ch)} disabled={!q.data || set.isPending} onValueChange={(v) => set.mutate({ channel: ch, status: v ? 'opted_in' : 'opted_out' })}
            trackColor={{ true: theme.primary, false: theme.border }} accessibilityLabel={t(`m.portal.channel.${ch}` as MessageKey)} />
        </View>
      ))}
    </View>
  );
}

const MORE_META = { esign: ['edit-3', 'm.portal.esign'], receipts: ['check-circle', 'm.portal.receipts'], profile: ['user', 'm.portal.profile'], consent: ['bell', 'm.portal.consent'] } as const;

function MoreMenu({ theme, grants, onOpen, branding }: { theme: Theme; grants: PortalGrants; onOpen(k: 'esign' | 'receipts' | 'profile' | 'consent'): void; branding?: Branding }) {
  const s = ui(theme);
  return (
    <ScrollView>
      {moreItems(grants).map((k) => (
        <Pressable key={k} style={[s.row, { minHeight: 48 }]} onPress={() => onOpen(k)} accessibilityRole="button">
          <Feather name={MORE_META[k][0]} size={18} color={theme.primary} style={{ marginRight: 10 }} />
          <Text style={[s.text, { flex: 1 }]}>{t(MORE_META[k][1])}</Text>
          <Feather name="chevron-right" size={18} color={theme.textMuted} />
        </Pressable>
      ))}
      {(branding?.supportEmail || branding?.supportPhone) && <Text style={[s.muted, { marginTop: 16 }]}>{t('m.portal.support', { contact: [branding.supportEmail, branding.supportPhone].filter(Boolean).join(' · ') })}</Text>}
      <Pressable style={s.button} onPress={() => void portalLogout()} accessibilityRole="button"><Text style={s.buttonText}>{t('common.signOut')}</Text></Pressable>
      <Text style={[s.muted, { marginTop: 8 }]}>{t('m.portal.signOutHint')}</Text>
    </ScrollView>
  );
}
