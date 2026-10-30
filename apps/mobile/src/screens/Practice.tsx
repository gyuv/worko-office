import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, NOTICE_OUTCOMES, type NoticeOutcome, type NoticeStatus } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Linking, Pressable, SectionList, Switch, Text, TextInput, View } from 'react-native';
import { hasGrant } from '../logic/billing';
import { searchClients } from '../logic/clients';
import { istTime } from '../logic/comm';
import {
  allowedTransitions, AUTHORITIES, buildHearingBody, buildStatusBody, canCancelEsign, canRetryEsign, expiryBand, filterNotices, groupNotices, hearingDay, hearingsInRange,
  isNoticeOverdue, mergeAccepted, nextSignLevel, noticeDaysLeft, refusalCode, reviewRows, searchDsc, toDscItems, toHearingItems, toNoticeItems, validateUdinForm,
  type ExpiryBand, type HearingForm, type HearingItem, type NoticeFilter, type NoticeItem, type ReviewRow, type UdinError,
} from '../logic/practice';
import { todayIST } from '../logic/registers';
import { extractNotice, pickImage } from '../net';
import { api, unwrap, useSession } from '../session';
import { syncNow, useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui, useTable } from '../ui';
import { useClientItems } from './Clients';
import { Header } from './Header';
import type { Nav } from './Stack';

const useUserId = () => useSession((x) => x.tokens?.userId ?? '');
const errMsg = (e: unknown) => (e as { message?: string })?.message ?? t('common.error');
const money = (p: number) => formatINR(p);
function useClientNames() {
  const clients = useClientItems();
  return useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
}
/** UI gating only (server enforces). Offline cold start ⇒ no actions; lists still render from sync. */
export function usePracticePerms() {
  const g = useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')) }).data?.grants;
  return {
    notices: hasGrant(g, 'notices', 'view'), noticeEdit: hasGrant(g, 'notices', 'edit'), noticeCreate: hasGrant(g, 'notices', 'create'),
    dsc: hasGrant(g, 'dsc', 'view'), dscEdit: hasGrant(g, 'dsc', 'edit'), audit: hasGrant(g, 'audit', 'view'), auditEdit: hasGrant(g, 'audit', 'edit'),
    esign: hasGrant(g, 'documents', 'view'), esignEdit: hasGrant(g, 'documents', 'edit'),
  };
}
function useNotices() { const r = useTable('notice'); return useMemo(() => toNoticeItems(r), [r]); }
function useHearings() { const r = useTable('notice_hearing'); return useMemo(() => toHearingItems(r), [r]); }

function Chip({ theme, on, label, onPress }: { theme: Theme; on: boolean; label: string; onPress(): void }) {
  const s = ui(theme);
  return (
    <Pressable onPress={onPress} style={[s.chipBtn, on && { backgroundColor: theme.primary, borderColor: theme.primary }]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
      <Text style={{ color: on ? theme.primaryText : theme.text }}>{label}</Text>
    </Pressable>
  );
}
function OnlineOnly({ theme }: { theme: Theme }) { return <Text accessibilityRole="alert" style={ui(theme).alert}>{t('m.notice.onlineOnly')}</Text>; }
function Line({ theme, label, value }: { theme: Theme; label: MessageKey; value: unknown }) {
  const s = ui(theme);
  return value === null || value === undefined || value === '' ? null : <Text style={[s.text, { marginTop: 2 }]}><Text style={s.muted}>{t(label)}: </Text>{String(value)}</Text>;
}
const authLabel = (a: string) => t(`m.notice.auth.${a}` as MessageKey);
const statusLabel = (st: string) => t(`m.notice.status.${st}` as MessageKey);
const whenLabel = (h: Pick<HearingItem, 'startsAt'>) => `${hearingDay(h)} ${istTime(h.startsAt)}`;

// ---------------- Notices ----------------
type Section = { key: 'overdue' | 'dueSoon' | 'hearingWeek' | 'other' | 'closed'; data: NoticeItem[] };

export function NoticeList({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const notices = useNotices();
  const hearings = useHearings();
  const names = useClientNames();
  const userId = useUserId();
  const perms = usePracticePerms();
  const today = todayIST();
  const [f, setF] = useState<NoticeFilter>({ status: 'open', authority: null, mine: false, q: '' });
  const sections = useMemo(() => {
    const shown = filterNotices(notices, f, userId, (id) => names.get(id));
    const g = groupNotices(shown, hearings, today);
    return (['overdue', 'dueSoon', 'hearingWeek', 'other', 'closed'] as const).map((key) => ({ key, data: g[key] })).filter((x) => x.data.length) as Section[];
  }, [notices, hearings, f, userId, names, today]);
  const authorities = useMemo(() => AUTHORITIES.filter((a) => notices.some((n) => n.authority === a)), [notices]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.notice.title')} onBack={onBack} right={<View style={{ flexDirection: 'row' }}>
        <Pressable style={s.icon} onPress={() => nav.push({ name: 'hearings' })} accessibilityRole="button" accessibilityLabel={t('m.notice.hearings')}>
          <Feather name="calendar" size={22} color={theme.primary} /></Pressable>
        {perms.noticeCreate && <Pressable style={s.icon} onPress={() => nav.push({ name: 'noticeScan' })} accessibilityRole="button" accessibilityLabel={t('m.notice.scan')}>
          <Feather name="camera" size={22} color={theme.primary} /></Pressable>}
      </View>} />
      <TextInput style={s.input} value={f.q} onChangeText={(q) => setF({ ...f, q })} placeholder={t('m.notice.search')} placeholderTextColor={theme.textMuted}
        accessibilityLabel={t('common.search')} autoCorrect={false} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {(['open', 'all', 'closed'] as const).map((st) => <Chip key={st} theme={theme} on={f.status === st} label={t(`m.notice.filter.${st}`)} onPress={() => setF({ ...f, status: st })} />)}
        <Chip theme={theme} on={f.mine} label={t('m.notice.filter.mine')} onPress={() => setF({ ...f, mine: !f.mine })} />
      </View>
      {authorities.length > 1 && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        <Chip theme={theme} on={!f.authority} label={t('m.notice.filter.anyAuthority')} onPress={() => setF({ ...f, authority: null })} />
        {authorities.map((a) => <Chip key={a} theme={theme} on={f.authority === a} label={authLabel(a)} onPress={() => setF({ ...f, authority: a })} />)}
      </View>}
      <SectionList sections={sections} keyExtractor={(x) => x.id} stickySectionHeadersEnabled={false} initialNumToRender={20}
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.notice.empty')}</Text>}
        renderSectionHeader={({ section }) => <Text style={[s.h2, section.key === 'overdue' && { color: theme.status.overdue }]}>{t(`m.notice.group.${section.key}`)} ({section.data.length})</Text>}
        renderItem={({ item }) => <NoticeRow theme={theme} n={item} client={names.get(item.clientId)} today={today} onPress={() => nav.push({ name: 'notice', id: item.id })} />} />
    </View>
  );
}

function NoticeRow({ theme, n, client, today, onPress }: { theme: Theme; n: NoticeItem; client?: string; today: string; onPress(): void }) {
  const s = ui(theme);
  const left = noticeDaysLeft(n, today);
  const overdue = isNoticeOverdue(n, today);
  const color = n.status === 'closed' ? theme.status.done : overdue ? theme.status.overdue : left !== null && left <= 7 ? theme.status.dueSoon : theme.status.inProgress;
  return (
    <Pressable style={s.row} onPress={onPress} accessibilityRole="button">
      <View style={{ width: 4, alignSelf: 'stretch', marginRight: 10, borderRadius: 2, backgroundColor: color }} />
      <View style={{ flex: 1 }}>
        <Text style={s.text} numberOfLines={1}>{n.title}</Text>
        <Text style={s.muted} numberOfLines={1}>{[client, authLabel(n.authority), n.section ? t('m.notice.us', { section: n.section }) : null, statusLabel(n.status)].filter(Boolean).join(' · ')}</Text>
      </View>
      {n.responseDue && n.status !== 'closed' && <Text style={[s.chip, { color }]}>
        {overdue ? t('m.notice.overdueDays', { days: -(left ?? 0) }) : left === 0 ? t('m.notice.dueToday') : t('m.notice.dueIn', { days: left ?? 0 })}</Text>}
    </Pressable>
  );
}

export function NoticeDetail({ theme, nav, id, onBack }: { theme: Theme; nav: Nav; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const n = useNotices().find((x) => x.id === id);
  const hearings = useHearings().filter((h) => h.noticeId === id).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  const names = useClientNames();
  const online = useSync((x) => x.online);
  const perms = usePracticePerms();
  const today = todayIST();
  const [msg, setMsg] = useState<string | null>(null);
  const [target, setTarget] = useState<NoticeStatus | null>(null);
  const [outcome, setOutcome] = useState<NoticeOutcome | null>(null);
  const [note, setNote] = useState('');
  const [finalDemand, setFinalDemand] = useState('');
  const [hearingForm, setHearingForm] = useState<{ mode: 'add' } | { mode: 'adjourn'; hearingId: string } | null>(null);
  const done = (m: MessageKey) => { setMsg(t(m)); void syncNow(); };
  const fail = (e: unknown) => setMsg(t('m.notice.failed', { reason: errMsg(e) }));
  const setStatus = useMutation({
    mutationFn: (body: object) => unwrap(api.POST('/notices/{id}/status', { params: { path: { id } }, body: body as never })),
    onSuccess: () => { setTarget(null); setOutcome(null); setNote(''); setFinalDemand(''); done('m.notice.statusChanged'); }, onError: fail,
  });
  const prep = useMutation({
    mutationFn: (v: { id: string; prepDone: boolean }) => unwrap(api.PATCH('/notices/hearings/{id}', { params: { path: { id: v.id } }, body: { prepDone: v.prepDone } as never })),
    onSuccess: () => done('m.notice.saved'), onError: fail,
  });
  if (!n) return <View><Header theme={theme} title="" onBack={onBack} /><Text style={s.muted}>{t('m.notice.notSynced')}</Text></View>;
  const transitions = allowedTransitions(n.status);
  function changeStatus() {
    if (!n || !target) return;
    const r = buildStatusBody(n.status, target, outcome, note, finalDemand);
    if (!r.ok) { setMsg(t(`m.notice.err.${r.error}`)); return; }
    setStatus.mutate(r.body);
  }
  const canEdit = perms.noticeEdit && online;
  return (
    <View>
      <Header theme={theme} title={n.title} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Line theme={theme} label="m.notice.client" value={names.get(n.clientId)} />
      <Line theme={theme} label="m.notice.authority" value={`${authLabel(n.authority)}${n.level ? ` · ${n.level.replace(/_/g, ' ')}` : ''}`} />
      <Line theme={theme} label="m.notice.section" value={n.section} />
      <Line theme={theme} label="m.notice.reference" value={n.referenceNo} />
      <Line theme={theme} label="m.notice.din" value={n.din} />
      <Line theme={theme} label="m.notice.ay" value={n.assessmentYear} />
      <Line theme={theme} label="m.notice.fy" value={n.financialYear ?? n.period} />
      <Line theme={theme} label="m.notice.issued" value={n.issueDate} />
      <Line theme={theme} label="m.notice.received" value={n.receivedOn} />
      <Line theme={theme} label="m.notice.responseDue" value={n.responseDue} />
      <Line theme={theme} label="m.notice.demand" value={money(n.demandPaise)} />
      {n.finalDemandPaise !== null && <Line theme={theme} label="m.notice.finalDemand" value={money(n.finalDemandPaise)} />}
      <Text style={[s.text, { marginTop: 8, fontWeight: '600', color: isNoticeOverdue(n, today) ? theme.status.overdue : theme.text }]}>
        {t('m.notice.statusLine', { status: statusLabel(n.status) })}{n.outcome ? ` · ${t(`m.notice.outcome.${n.outcome}` as MessageKey)}` : ''}</Text>

      {perms.noticeEdit && transitions.length > 0 && <>
        <Text style={s.h2}>{t('m.notice.changeStatus')}</Text>
        {!online ? <OnlineOnly theme={theme} /> : <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {transitions.map((st) => <Chip key={st} theme={theme} on={target === st} label={statusLabel(st)} onPress={() => setTarget(target === st ? null : st)} />)}
          </View>
          {target === 'closed' && <>
            <Text style={s.label}>{t('m.notice.outcomeLabel')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {NOTICE_OUTCOMES.map((o) => <Chip key={o} theme={theme} on={outcome === o} label={t(`m.notice.outcome.${o}`)} onPress={() => setOutcome(o)} />)}
            </View>
            <Text style={s.label}>{t('m.notice.finalDemandRupees')}</Text>
            <TextInput style={s.input} value={finalDemand} onChangeText={setFinalDemand} keyboardType="decimal-pad" accessibilityLabel={t('m.notice.finalDemandRupees')} />
            <Text style={s.label}>{t('m.notice.outcomeNote')}</Text>
            <TextInput style={[s.input, { minHeight: 64, textAlignVertical: 'top' }]} value={note} onChangeText={setNote} multiline accessibilityLabel={t('m.notice.outcomeNote')} />
          </>}
          {target && <Pressable style={[s.button, setStatus.isPending && { opacity: 0.5 }]} disabled={setStatus.isPending} onPress={changeStatus} accessibilityRole="button">
            <Text style={s.buttonText}>{t('m.notice.moveTo', { status: statusLabel(target) })}</Text></Pressable>}
        </>}
      </>}

      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[s.h2, { flex: 1 }]}>{t('m.notice.hearings')}</Text>
        {canEdit && n.status !== 'closed' && <Pressable style={s.ghost} onPress={() => setHearingForm({ mode: 'add' })} accessibilityRole="button">
          <Feather name="plus" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.notice.addHearing')}</Text></Pressable>}
      </View>
      {hearingForm && <HearingFormView theme={theme} noticeId={id} target={hearingForm} onDone={() => { setHearingForm(null); done('m.notice.hearingSaved'); }} onCancel={() => setHearingForm(null)} />}
      {!hearings.length && <Text style={s.muted}>{t('m.notice.noHearings')}</Text>}
      {hearings.map((h) => (
        <View key={h.id} style={[s.row, { flexWrap: 'wrap' }]}>
          <View style={{ flex: 1, minWidth: 180 }}>
            <Text style={s.text}>{whenLabel(h)} · {t(`m.notice.hstatus.${h.status}`)}</Text>
            <Text style={s.muted} numberOfLines={2}>{[h.venue, h.virtualLink ? t('m.notice.virtual') : null, h.status === 'scheduled' ? t(h.prepDone ? 'm.notice.prepDone' : 'm.notice.prepPending') : null].filter(Boolean).join(' · ')}</Text>
          </View>
          {h.virtualLink && <Pressable style={s.icon} onPress={() => void Linking.openURL(h.virtualLink!)} accessibilityRole="link" accessibilityLabel={t('m.notice.joinLink')}>
            <Feather name="video" size={18} color={theme.primary} /></Pressable>}
          {canEdit && h.status === 'scheduled' && <>
            <Pressable style={s.ghost} onPress={() => prep.mutate({ id: h.id, prepDone: !h.prepDone })} accessibilityRole="button">
              <Text style={s.ghostText}>{t(h.prepDone ? 'm.notice.unmarkPrep' : 'm.notice.markPrep')}</Text></Pressable>
            <Pressable style={[s.ghost, { marginLeft: 6 }]} onPress={() => setHearingForm({ mode: 'adjourn', hearingId: h.id })} accessibilityRole="button">
              <Text style={s.ghostText}>{t('m.notice.adjourn')}</Text></Pressable>
          </>}
        </View>
      ))}
      {perms.noticeCreate && online && n.status !== 'closed' && <Pressable style={[s.ghost, { marginTop: 16, alignSelf: 'flex-start' }]}
        onPress={() => nav.push({ name: 'noticeScan', clientId: n.clientId, noticeId: n.id })} accessibilityRole="button">
        <Feather name="camera" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.notice.scanMore')}</Text></Pressable>}
    </View>
  );
}

function HearingFormView({ theme, noticeId, target, onDone, onCancel }: { theme: Theme; noticeId: string; target: { mode: 'add' } | { mode: 'adjourn'; hearingId: string }; onDone(): void; onCancel(): void }) {
  const s = ui(theme);
  const [f, setF] = useState<HearingForm>({ date: todayIST(), start: '11:00', end: '', venue: '', link: '', ...(target.mode === 'adjourn' ? { reason: '' } : {}) });
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: object) => target.mode === 'add'
      ? unwrap(api.POST('/notices/{id}/hearings', { params: { path: { id: noticeId } }, body: body as never }))
      : unwrap(api.POST('/notices/hearings/{id}/adjourn', { params: { path: { id: target.hearingId } }, body: body as never })),
    onSuccess: onDone, onError: (e) => setErr(t('m.notice.failed', { reason: errMsg(e) })),
  });
  function submit() {
    const r = buildHearingBody(f, todayIST());
    if (!r.ok) { setErr(t(`m.notice.herr.${r.error}`)); return; }
    setErr(null); save.mutate(r.body);
  }
  const field = (k: 'date' | 'start' | 'end' | 'venue' | 'link' | 'reason', label: MessageKey, kb: 'default' | 'numbers-and-punctuation' | 'url' = 'default') => (
    <><Text style={s.label}>{t(label)}</Text>
      <TextInput style={s.input} value={f[k] ?? ''} onChangeText={(v) => setF({ ...f, [k]: v })} keyboardType={kb} autoCapitalize="none" accessibilityLabel={t(label)} /></>
  );
  return (
    <View style={{ padding: 12, borderRadius: 6, backgroundColor: theme.surfaceAlt, marginBottom: 8 }}>
      <Text style={s.text}>{t(target.mode === 'add' ? 'm.notice.addHearing' : 'm.notice.adjournTitle')}</Text>
      {err && <Text accessibilityRole="alert" style={s.alert}>{err}</Text>}
      {field('date', 'm.notice.hDate', 'numbers-and-punctuation')}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>{field('start', 'm.notice.hStart', 'numbers-and-punctuation')}</View>
        <View style={{ flex: 1 }}>{field('end', 'm.notice.hEnd', 'numbers-and-punctuation')}</View>
      </View>
      {field('venue', 'm.notice.hVenue')}
      {field('link', 'm.notice.hLink', 'url')}
      {target.mode === 'adjourn' && field('reason', 'm.notice.hReason')}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable style={[s.button, { flex: 1 }, save.isPending && { opacity: 0.5 }]} disabled={save.isPending} onPress={submit} accessibilityRole="button"><Text style={s.buttonText}>{t('common.save')}</Text></Pressable>
        <Pressable style={[s.ghost, { marginTop: 12 }]} onPress={onCancel} accessibilityRole="button"><Text style={s.ghostText}>{t('common.cancel')}</Text></Pressable>
      </View>
    </View>
  );
}

// ---------------- Scan a notice (online only) ----------------
const FIELD_LABEL: Record<string, MessageKey> = {
  authority: 'm.notice.authority', section: 'm.notice.section', din: 'm.notice.din', referenceNo: 'm.notice.reference', assessmentYear: 'm.notice.ay',
  financialYear: 'm.notice.fy', issueDate: 'm.notice.issued', responseDue: 'm.notice.responseDue', demandPaise: 'm.notice.demandRupees',
};

export function NoticeScan({ theme, nav, clientId: fixedClient, noticeId, onBack }: { theme: Theme; nav: Nav; clientId?: string; noticeId?: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const clients = useClientItems();
  const [clientId, setClientId] = useState(fixedClient ?? '');
  const [clientQ, setClientQ] = useState('');
  const [file, setFile] = useState<{ uri: string; name: string; type: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<{ id: string; provider: string } | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [title, setTitle] = useState('');
  const client = clients.find((c) => c.id === clientId);
  const matches = useMemo(() => (clientQ ? searchClients(clients, clientQ).slice(0, 8) : []), [clients, clientQ]);

  async function pick(src: 'camera' | 'library') {
    setMsg(null);
    const r = await pickImage(src);
    if (r === 'denied') { setMsg(t('m.doc.noPermission')); const lib = await pickImage('library'); if (lib && lib !== 'denied') setFile(lib); return; }
    if (r) setFile(r);
  }
  async function extract() {
    if (!file || !clientId) return;
    setBusy(true); setMsg(null);
    try {
      const x = await extractNotice(file, { clientId, noticeId });
      setExtraction({ id: x.id, provider: x.provider }); setRows(reviewRows(x.suggestions ?? []));
      if (!(x.suggestions ?? []).length) setMsg(t('m.notice.noSuggestions'));
      void syncNow();
    } catch (e) { setMsg(t('m.notice.failed', { reason: errMsg(e) })); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!extraction) return;
    const m = mergeAccepted(rows, !noticeId);
    if (!m.ok) { setMsg(t('m.notice.reviewFix', { fields: m.errors.map((f) => t(FIELD_LABEL[f] ?? 'm.notice.authority')).join(', ') })); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await unwrap(api.POST('/notices/extractions/{id}/confirm', { params: { path: { id: extraction.id } }, body: { fields: m.fields, ...(title.trim() ? { title: title.trim() } : {}) } as never }));
      void syncNow();
      const nid = (r as { noticeId?: string }).noticeId ?? noticeId;
      if (nid) nav.replace({ name: 'notice', id: nid }); else onBack?.();
    } catch (e) { setMsg(t('m.notice.failed', { reason: errMsg(e) })); } finally { setBusy(false); }
  }
  async function discard() {
    if (extraction) await unwrap(api.POST('/notices/extractions/{id}/discard', { params: { path: { id: extraction.id } } })).catch(() => undefined);
    setExtraction(null); setRows([]); setFile(null); setMsg(t('m.notice.discarded'));
  }
  const setRow = (i: number, p: Partial<ReviewRow>) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...p } : r)));

  return (
    <View>
      <Header theme={theme} title={t(noticeId ? 'm.notice.scanMore' : 'm.notice.scan')} onBack={onBack} />
      {!online && <OnlineOnly theme={theme} />}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {!extraction ? <>
        <Text style={s.label}>{t('m.notice.client')}</Text>
        {client ? (
          <View style={s.row}>
            <Text style={[s.text, { flex: 1 }]}>{client.name}</Text>
            {!fixedClient && <Pressable style={s.icon} onPress={() => setClientId('')} accessibilityRole="button" accessibilityLabel={t('m.reg.pickClient')}><Feather name="x" size={18} color={theme.textMuted} /></Pressable>}
          </View>
        ) : <View>
          <TextInput style={s.input} value={clientQ} onChangeText={setClientQ} placeholder={t('m.clients.search')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.reg.pickClient')} autoCorrect={false} />
          {matches.map((c) => <Pressable key={c.id} style={s.row} onPress={() => { setClientId(c.id); setClientQ(''); }} accessibilityRole="button"><Text style={s.text}>{c.name}</Text></Pressable>)}
        </View>}
        {!file ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Pressable style={[s.button, { flex: 1 }]} onPress={() => void pick('camera')} accessibilityRole="button"><Text style={s.buttonText}>{t('m.doc.camera')}</Text></Pressable>
            <Pressable style={[s.button, { flex: 1 }]} onPress={() => void pick('library')} accessibilityRole="button"><Text style={s.buttonText}>{t('m.doc.library')}</Text></Pressable>
          </View>
        ) : <View>
          <Image source={{ uri: file.uri }} style={{ width: '100%', height: 240, resizeMode: 'contain', marginTop: 12, backgroundColor: theme.surfaceAlt }} accessibilityIgnoresInvertColors />
          <Pressable style={[s.ghost, { marginTop: 8, alignSelf: 'flex-start' }]} onPress={() => setFile(null)} accessibilityRole="button"><Text style={s.ghostText}>{t('m.doc.retake')}</Text></Pressable>
          <Pressable style={[s.button, (busy || !online || !clientId) && { opacity: 0.5 }]} disabled={busy || !online || !clientId} onPress={() => void extract()} accessibilityRole="button">
            {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={s.buttonText}>{t('m.notice.extract')}</Text>}</Pressable>
        </View>}
      </> : <>
        <Text style={s.muted}>{t('m.notice.reviewHint', { provider: extraction.provider })}</Text>
        {!noticeId && <>
          <Text style={s.label}>{t('m.notice.titleField')}</Text>
          <TextInput style={s.input} value={title} onChangeText={setTitle} accessibilityLabel={t('m.notice.titleField')} />
        </>}
        {rows.map((r, i) => (
          <View key={r.field} style={[s.row, { alignItems: 'flex-start' }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.muted}>{t(FIELD_LABEL[r.field] ?? 'm.notice.authority')} · {t('m.notice.confidence', { pct: Math.round(r.confidence * 100) })}</Text>
              <TextInput style={[s.input, !r.accepted && { opacity: 0.5 }]} value={r.value} editable={r.accepted} onChangeText={(v) => setRow(i, { value: v })}
                autoCapitalize="none" accessibilityLabel={t(FIELD_LABEL[r.field] ?? 'm.notice.authority')} />
              <Text style={s.muted} numberOfLines={2}>“{r.source}”</Text>
            </View>
            <Switch value={r.accepted} onValueChange={(v) => setRow(i, { accepted: v })} accessibilityLabel={t('m.notice.accept')} style={{ marginLeft: 8, marginTop: 20 }} />
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable style={[s.button, { flex: 1 }, (busy || !online) && { opacity: 0.5 }]} disabled={busy || !online} onPress={() => void confirm()} accessibilityRole="button">
            {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={s.buttonText}>{t('m.notice.confirm')}</Text>}</Pressable>
          <Pressable style={[s.ghost, { marginTop: 12 }]} onPress={() => void discard()} accessibilityRole="button"><Text style={s.ghostText}>{t('m.notice.discard')}</Text></Pressable>
        </View>
      </>}
    </View>
  );
}

// ---------------- Hearings ----------------
export function Hearings({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const hearings = useHearings();
  const notices = useNotices();
  const names = useClientNames();
  const [range, setRange] = useState<1 | 7>(1);
  const today = todayIST();
  const list = useMemo(() => hearingsInRange(hearings, today, range), [hearings, today, range]);
  const byId = useMemo(() => new Map(notices.map((n) => [n.id, n])), [notices]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.notice.hearings')} onBack={onBack} />
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
        <Chip theme={theme} on={range === 1} label={t('m.notice.today')} onPress={() => setRange(1)} />
        <Chip theme={theme} on={range === 7} label={t('m.notice.thisWeek')} onPress={() => setRange(7)} />
      </View>
      <FlatList data={list} keyExtractor={(x) => x.id} ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.notice.noHearingsRange')}</Text>}
        renderItem={({ item }) => {
          const n = byId.get(item.noticeId);
          return (
            <Pressable style={s.row} onPress={() => nav.push({ name: 'notice', id: item.noticeId })} accessibilityRole="button">
              <View style={{ width: 64 }}><Text style={s.text}>{istTime(item.startsAt)}</Text>{range === 7 && <Text style={s.muted}>{hearingDay(item).slice(5)}</Text>}</View>
              <View style={{ flex: 1 }}>
                <Text style={s.text} numberOfLines={1}>{n?.title ?? t('m.notice.title')}</Text>
                <Text style={s.muted} numberOfLines={1}>{[names.get(item.clientId), item.venue, item.virtualLink ? t('m.notice.virtual') : null].filter(Boolean).join(' · ')}</Text>
              </View>
              {!item.prepDone && <Text style={[s.chip, { color: theme.status.dueSoon }]}>{t('m.notice.prepPending')}</Text>}
            </Pressable>
          );
        }} />
    </View>
  );
}

// ---------------- DSC register ----------------
const bandColor = (theme: Theme, b: ExpiryBand) => (b === 'expired' || b === 'critical' ? theme.status.overdue : b === 'warning' ? theme.status.dueSoon : b === 'ok' ? theme.status.done : theme.status.notStarted);

export function DscList({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const rows = useTable('dsc');
  const names = useClientNames();
  const today = todayIST();
  const [q, setQ] = useState('');
  const items = useMemo(() => searchDsc(toDscItems(rows), q, (id) => names.get(id), today), [rows, q, names, today]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.dsc.title')} onBack={onBack} />
      <TextInput style={s.input} value={q} onChangeText={setQ} placeholder={t('m.dsc.search')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('common.search')} autoCorrect={false} autoCapitalize="none" />
      <FlatList data={items} keyExtractor={(x) => x.id} initialNumToRender={20} keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.dsc.empty')}</Text>}
        renderItem={({ item }) => {
          const band = expiryBand(item.validTo, today);
          return (
            <Pressable style={s.row} onPress={() => nav.push({ name: 'dsc', id: item.id })} accessibilityRole="button">
              <View style={{ width: 4, alignSelf: 'stretch', marginRight: 10, borderRadius: 2, backgroundColor: bandColor(theme, band) }} />
              <View style={{ flex: 1 }}>
                <Text style={s.text} numberOfLines={1}>{item.holderName}{item.clientId && names.get(item.clientId) ? ` · ${names.get(item.clientId)}` : ''}</Text>
                <Text style={s.muted} numberOfLines={1}>{[t(`m.dsc.custody.${item.custody}`), item.tokenLabel, item.serialNo].filter(Boolean).join(' · ')}</Text>
              </View>
              <Text style={[s.chip, { color: bandColor(theme, band) }]}>{t(`m.dsc.band.${band}`, { date: item.validTo ?? '' })}</Text>
            </Pressable>
          );
        }} />
    </View>
  );
}

type CustodyMove = { id: string; toCustody: string; toUserId: string | null; counterparty: string | null; purpose: string | null; movedAt: string; acknowledgedAt: string | null; acknowledgedName: string | null };

export function DscDetail({ theme, id, onBack }: { theme: Theme; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const d = toDscItems(useTable('dsc')).find((x) => x.id === id);
  const names = useClientNames();
  const online = useSync((x) => x.online);
  const perms = usePracticePerms();
  const userId = useUserId();
  const qcl = useQueryClient();
  const today = todayIST();
  const [msg, setMsg] = useState<string | null>(null);
  const [to, setTo] = useState<'in_office' | 'with_client' | 'with_staff'>('in_office');
  const [counterparty, setCounterparty] = useState('');
  const [purpose, setPurpose] = useState('');
  const [ackName, setAckName] = useState('');
  const full = useQuery({ queryKey: ['dsc', id], enabled: online, queryFn: async () => (await unwrap(api.GET('/dsc/{id}', { params: { path: { id } } }))) as unknown as { custodyLog: CustodyMove[]; daysLeft: number } });
  const refresh = (m: MessageKey) => { setMsg(t(m)); void syncNow(); void qcl.invalidateQueries({ queryKey: ['dsc', id] }); };
  const fail = (e: unknown) => setMsg(t('m.dsc.failed', { reason: errMsg(e) }));
  const move = useMutation({
    mutationFn: () => unwrap(api.POST('/dsc/{id}/custody', { params: { path: { id } }, body: {
      to, toUserId: to === 'with_staff' ? userId : null, counterparty: counterparty.trim() || null, purpose: purpose.trim() || null } as never })),
    onSuccess: () => { setCounterparty(''); setPurpose(''); refresh('m.dsc.moved'); }, onError: fail,
  });
  const ack = useMutation({
    mutationFn: (mid: string) => unwrap(api.POST('/dsc/custody/{id}/acknowledge', { params: { path: { id: mid } }, body: { name: ackName.trim() || null } as never })),
    onSuccess: () => { setAckName(''); refresh('m.dsc.acknowledged'); }, onError: fail,
  });
  if (!d) return <View><Header theme={theme} title="" onBack={onBack} /><Text style={s.muted}>{t('m.dsc.notSynced')}</Text></View>;
  const band = expiryBand(d.validTo, today);
  const log = full.data?.custodyLog ?? [];
  const latest = log[log.length - 1];
  const pendingAck = latest && !latest.acknowledgedAt && latest.toCustody !== 'new' ? latest : null;
  const mayAck = pendingAck && (pendingAck.toUserId ? pendingAck.toUserId === userId : perms.dscEdit);
  return (
    <View>
      <Header theme={theme} title={d.holderName} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Text style={[s.text, { fontWeight: '600', color: bandColor(theme, band) }]}>{t(`m.dsc.band.${band}`, { date: d.validTo ?? '' })}</Text>
      <Line theme={theme} label="m.dsc.client" value={d.clientId ? names.get(d.clientId) : t('m.dsc.firm')} />
      <Line theme={theme} label="m.dsc.class" value={`${d.dscClass} · ${d.dscType}`} />
      <Line theme={theme} label="m.dsc.issuer" value={d.issuer} />
      <Line theme={theme} label="m.dsc.serial" value={d.serialNo} />
      <Line theme={theme} label="m.dsc.token" value={d.tokenLabel} />
      <Line theme={theme} label="m.dsc.validity" value={`${d.validFrom ?? '—'} → ${d.validTo ?? '—'}`} />
      <Line theme={theme} label="m.dsc.custodyNow" value={`${t(`m.dsc.custody.${d.custody}`)}${d.custodyUserId === userId ? ` · ${t('m.dsc.you')}` : ''}`} />
      <Text style={s.muted}>{t('m.dsc.noSecrets')}</Text>

      <Text style={s.h2}>{t('m.dsc.log')}</Text>
      {!online ? <OnlineOnly theme={theme} /> : full.isLoading ? <ActivityIndicator /> : full.isError ? <Text style={s.muted}>{errMsg(full.error)}</Text>
        : log.slice().reverse().slice(0, 10).map((m) => (
          <Text key={m.id} style={[s.muted, { marginTop: 2 }]}>{String(m.movedAt).slice(0, 10)} · {m.toCustody === 'new' ? t('m.dsc.registered') : t(`m.dsc.custody.${m.toCustody}` as MessageKey)}
            {m.counterparty ? ` · ${m.counterparty}` : ''}{m.acknowledgedAt ? ` · ${t('m.dsc.acked', { name: m.acknowledgedName ?? '' })}` : ''}</Text>
        ))}
      {online && pendingAck && mayAck && <View style={{ marginTop: 8 }}>
        {!pendingAck.toUserId && <><Text style={s.label}>{t('m.dsc.receiverName')}</Text>
          <TextInput style={s.input} value={ackName} onChangeText={setAckName} accessibilityLabel={t('m.dsc.receiverName')} /></>}
        <Pressable style={s.button} onPress={() => ack.mutate(pendingAck.id)} disabled={ack.isPending} accessibilityRole="button"><Text style={s.buttonText}>{t('m.dsc.acknowledge')}</Text></Pressable>
      </View>}

      {perms.dscEdit && online && <>
        <Text style={s.h2}>{t('m.dsc.move')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(['in_office', 'with_client', 'with_staff'] as const).map((c) => <Chip key={c} theme={theme} on={to === c} label={t(c === 'with_staff' ? 'm.dsc.toMe' : `m.dsc.custody.${c}`)} onPress={() => setTo(c)} />)}
        </View>
        <Text style={s.label}>{t('m.dsc.counterparty')}</Text>
        <TextInput style={s.input} value={counterparty} onChangeText={setCounterparty} accessibilityLabel={t('m.dsc.counterparty')} />
        <Text style={s.label}>{t('m.dsc.purpose')}</Text>
        <TextInput style={s.input} value={purpose} onChangeText={setPurpose} accessibilityLabel={t('m.dsc.purpose')} />
        <Pressable style={[s.button, move.isPending && { opacity: 0.5 }]} disabled={move.isPending || to === d.custody && to !== 'with_staff'} onPress={() => move.mutate()} accessibilityRole="button">
          <Text style={s.buttonText}>{t('m.dsc.record')}</Text></Pressable>
      </>}
    </View>
  );
}

// ---------------- Audit on the go (online) ----------------
type Engagement = { id: string; clientId: string; clientName: string | null; fy: string; auditType: string; status: string; partnerId: string | null; managerId: string | null; udinRequired: boolean; udinRecorded: boolean | null };
type Procedure = { id: string; sectionTitle: string; title: string; notApplicable: boolean; preparedBy: string | null; reviewedBy: string | null; partnerBy: string | null; workpapers: number; requiredEvidence: string[] | null };
type Udin = { id: string; udin: string; documentType: string; generatedOn: string; revokedAt: string | null };
type EngagementFull = Engagement & { procedures: Procedure[]; udins: Udin[]; progress: { total: number; prepared: number; reviewed: number; partner: number } };

export function AuditList({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const userId = useUserId();
  const [mine, setMine] = useState(true);
  const q = useQuery({ queryKey: ['audit', 'engagements'], enabled: online,
    queryFn: async () => ((await unwrap(api.GET('/audit/engagements', { params: { query: { limit: 200 } } }))) as unknown as { items: Engagement[] }).items });
  const list = (q.data ?? []).filter((e) => e.status !== 'closed' && (!mine || e.partnerId === userId || e.managerId === userId));
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.audit.title')} onBack={onBack} />
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
        <Chip theme={theme} on={mine} label={t('m.audit.mine')} onPress={() => setMine(true)} />
        <Chip theme={theme} on={!mine} label={t('m.audit.all')} onPress={() => setMine(false)} />
      </View>
      {!online ? <OnlineOnly theme={theme} /> : q.isLoading ? <ActivityIndicator /> : q.isError ? <Text style={s.muted}>{errMsg(q.error)}</Text> : (
        <FlatList data={list} keyExtractor={(x) => x.id} onRefresh={() => void q.refetch()} refreshing={q.isFetching}
          ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.audit.empty')}</Text>}
          renderItem={({ item }) => (
            <Pressable style={s.row} onPress={() => nav.push({ name: 'engagement', id: item.id })} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Text style={s.text} numberOfLines={1}>{item.clientName} · {item.fy}</Text>
                <Text style={s.muted}>{[item.auditType.replace(/_/g, ' '), t(`m.audit.status.${item.status}` as MessageKey), item.udinRequired ? t(item.udinRecorded ? 'm.audit.udinOk' : 'm.audit.udinMissing') : null].filter(Boolean).join(' · ')}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={theme.textMuted} />
            </Pressable>
          )} />
      )}
    </View>
  );
}

const REFUSAL_KEY = {
  self_review: 'm.audit.refuse.self_review', preparer_signoff_required: 'm.audit.refuse.preparer_signoff_required', reviewer_signoff_required: 'm.audit.refuse.reviewer_signoff_required',
  already_signed: 'm.audit.refuse.already_signed', evidence_changed: 'm.audit.refuse.evidence_changed', forbidden: 'm.audit.refuse.forbidden', other: 'm.audit.refuse.other',
} as const;

export function EngagementDetail({ theme, id, onBack }: { theme: Theme; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const perms = usePracticePerms();
  const qcl = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [udinOpen, setUdinOpen] = useState(false);
  const q = useQuery({ queryKey: ['audit', 'engagement', id], enabled: online, queryFn: async () => (await unwrap(api.GET('/audit/engagements/{id}', { params: { path: { id } } }))) as unknown as EngagementFull });
  const sign = useMutation({
    mutationFn: (v: { id: string; level: string }) => unwrap(api.POST('/audit/procedures/{id}/signoff', { params: { path: { id: v.id } }, body: { level: v.level } as never })),
    onSuccess: () => { setMsg(t('m.audit.signed')); void qcl.invalidateQueries({ queryKey: ['audit'] }); },
    onError: (e) => { const x = e as { code?: string; status?: number; message?: string }; setMsg(t(REFUSAL_KEY[refusalCode(x.code, x.status)], { reason: x.message ?? '' })); },
  });
  const e = q.data;
  const sections = useMemo(() => {
    const m = new Map<string, Procedure[]>();
    for (const p of e?.procedures ?? []) m.set(p.sectionTitle, [...(m.get(p.sectionTitle) ?? []), p]);
    return [...m.entries()];
  }, [e]);
  if (!online) return <View><Header theme={theme} title={t('m.audit.title')} onBack={onBack} /><OnlineOnly theme={theme} /></View>;
  if (!e) return <View><Header theme={theme} title={t('m.audit.title')} onBack={onBack} />{q.isError ? <Text style={s.muted}>{errMsg(q.error)}</Text> : <ActivityIndicator />}</View>;
  return (
    <View>
      <Header theme={theme} title={`${e.clientName ?? ''} · ${e.fy}`} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Text style={s.muted}>{t('m.audit.progress', { prepared: e.progress.prepared, reviewed: e.progress.reviewed, partner: e.progress.partner, total: e.progress.total })}</Text>

      <Text style={s.h2}>{t('m.audit.udins')}</Text>
      {e.udinRequired && !e.udins.some((u) => !u.revokedAt) && <Text style={[s.text, { color: theme.status.overdue }]}>{t('m.audit.udinMissing')}</Text>}
      {e.udins.map((u) => <Text key={u.id} style={[s.text, u.revokedAt && { textDecorationLine: 'line-through', color: theme.textMuted }]}>{u.udin} · {u.documentType} · {u.generatedOn}</Text>)}
      {perms.auditEdit && (udinOpen
        ? <UdinEntry theme={theme} clientId={e.clientId} engagementId={e.id} onDone={() => { setUdinOpen(false); setMsg(t('m.audit.udinSaved')); void qcl.invalidateQueries({ queryKey: ['audit'] }); }} onCancel={() => setUdinOpen(false)} />
        : <Pressable style={[s.ghost, { alignSelf: 'flex-start', marginTop: 8 }]} onPress={() => setUdinOpen(true)} accessibilityRole="button"><Text style={s.ghostText}>{t('m.audit.recordUdin')}</Text></Pressable>)}

      {sections.map(([title, procs]) => (
        <View key={title}>
          <Text style={s.h2}>{title}</Text>
          {procs.map((p) => {
            const level = nextSignLevel(p);
            return (
              <View key={p.id} style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.text}>{p.title}</Text>
                  <Text style={s.muted}>{p.notApplicable ? t('m.audit.na') : [p.preparedBy ? '✓ P' : '· P', p.reviewedBy ? '✓ R' : '· R', p.partnerBy ? '✓ EP' : '· EP'].join('  ')}
                    {` · ${t('m.audit.workpapers', { count: p.workpapers })}`}</Text>
                </View>
                {perms.auditEdit && level && <Pressable style={[s.ghost, sign.isPending && { opacity: 0.5 }]} disabled={sign.isPending}
                  onPress={() => Alert.alert(t('m.audit.signAs', { level: t(`m.audit.level.${level}`) }), p.title, [
                    { text: t('common.cancel'), style: 'cancel' }, { text: t('m.audit.sign'), onPress: () => { setMsg(null); sign.mutate({ id: p.id, level }); } }])}
                  accessibilityRole="button"><Text style={s.ghostText}>{t(`m.audit.level.${level}`)}</Text></Pressable>}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const UDIN_ERR: Record<UdinError, MessageKey> = {
  udin_empty: 'm.audit.uerr.udin_empty', udin_length: 'm.audit.uerr.udin_length', udin_format: 'm.audit.uerr.udin_format', membership: 'm.audit.uerr.membership',
  document_type: 'm.audit.uerr.document_type', date: 'm.audit.uerr.date', future: 'm.audit.uerr.future',
};

/** Entry of a UDIN already generated on the official ICAI portal. This app never generates UDINs nor imitates that screen. */
function UdinEntry({ theme, clientId, engagementId, onDone, onCancel }: { theme: Theme; clientId: string; engagementId: string; onDone(): void; onCancel(): void }) {
  const s = ui(theme);
  const [f, setF] = useState({ udin: '', membershipNo: '', documentType: '', generatedOn: todayIST() });
  const [errs, setErrs] = useState<string[]>([]);
  const portal = useQuery({ queryKey: ['audit', 'udin-portal'], queryFn: () => unwrap(api.GET('/audit/udin-portal')) });
  const save = useMutation({
    mutationFn: (body: object) => unwrap(api.POST('/audit/udins', { body: body as never })),
    onSuccess: onDone,
    onError: (e) => { const x = e as { code?: string; message?: string }; setErrs([x.code === 'udin_duplicate' ? t('m.audit.uerr.duplicate') : t('m.audit.refuse.other', { reason: x.message ?? '' })]); },
  });
  function submit() {
    const r = validateUdinForm(f);
    if (!r.ok) { setErrs(r.errors.map((k) => t(UDIN_ERR[k]))); return; }
    setErrs([]); save.mutate({ clientId, engagementId, ...r.value });
  }
  const url = portal.data?.url;
  const field = (k: keyof typeof f, label: MessageKey, extra: object = {}) => (
    <><Text style={s.label}>{t(label)}</Text><TextInput style={s.input} value={f[k]} onChangeText={(v) => setF({ ...f, [k]: v })} accessibilityLabel={t(label)} {...extra} /></>
  );
  return (
    <View style={{ padding: 12, borderRadius: 6, backgroundColor: theme.surfaceAlt, marginTop: 8 }}>
      <Text style={s.muted}>{t('m.audit.udinHint')}</Text>
      {url && <Pressable style={[s.ghost, { alignSelf: 'flex-start', marginTop: 8 }]} onPress={() => void Linking.openURL(url)} accessibilityRole="link">
        <Feather name="external-link" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.audit.openPortal')}</Text></Pressable>}
      {errs.map((x) => <Text key={x} accessibilityRole="alert" style={[s.text, { color: theme.status.overdue, marginTop: 4 }]}>{x}</Text>)}
      {field('udin', 'm.audit.udin', { autoCapitalize: 'characters', autoCorrect: false, maxLength: 24 })}
      {field('membershipNo', 'm.audit.membershipNo', { keyboardType: 'number-pad', maxLength: 6 })}
      {field('documentType', 'm.audit.documentType')}
      {field('generatedOn', 'm.audit.generatedOn', { keyboardType: 'numbers-and-punctuation' })}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable style={[s.button, { flex: 1 }, save.isPending && { opacity: 0.5 }]} disabled={save.isPending} onPress={submit} accessibilityRole="button"><Text style={s.buttonText}>{t('common.save')}</Text></Pressable>
        <Pressable style={[s.ghost, { marginTop: 12 }]} onPress={onCancel} accessibilityRole="button"><Text style={s.ghostText}>{t('common.cancel')}</Text></Pressable>
      </View>
    </View>
  );
}

// ---------------- E-sign status (online) ----------------
type EsignSummary = { id: string; title: string; status: string; items: number; visibleItems: number; createdAt: string; mode: string };
type EsignFull = { id: string; title: string; status: string; mode: string; items: Array<{ id: string; documentName: string; status: string; error: string | null; signers: Array<{ id: string; name: string; status: string; signedAt: string | null }> }> };
const esignStatus = (st: string) => t(`m.esign.status.${st}` as MessageKey);

export function EsignList({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const q = useQuery({ queryKey: ['esign', 'list'], enabled: online,
    queryFn: async () => ((await unwrap(api.GET('/esign/requests', { params: { query: { limit: 100 } } }))) as unknown as { items: EsignSummary[] }).items });
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.esign.title')} onBack={onBack} />
      {!online ? <OnlineOnly theme={theme} /> : q.isLoading ? <ActivityIndicator /> : q.isError ? <Text style={s.muted}>{errMsg(q.error)}</Text> : (
        <FlatList data={q.data ?? []} keyExtractor={(x) => x.id} onRefresh={() => void q.refetch()} refreshing={q.isFetching}
          ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.esign.empty')}</Text>}
          renderItem={({ item }) => (
            <Pressable style={s.row} onPress={() => nav.push({ name: 'esign', id: item.id })} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Text style={s.text} numberOfLines={1}>{item.title}</Text>
                <Text style={s.muted}>{[esignStatus(item.status), t('m.esign.docs', { count: item.visibleItems }), String(item.createdAt).slice(0, 10)].join(' · ')}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={theme.textMuted} />
            </Pressable>
          )} />
      )}
    </View>
  );
}

export function EsignDetail({ theme, id, onBack }: { theme: Theme; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const perms = usePracticePerms();
  const qcl = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['esign', id], enabled: online, queryFn: async () => (await unwrap(api.GET('/esign/requests/{id}', { params: { path: { id } } }))) as unknown as EsignFull });
  const after = (m: MessageKey) => { setMsg(t(m)); void qcl.invalidateQueries({ queryKey: ['esign'] }); };
  const fail = (e: unknown) => setMsg(t('m.esign.failed', { reason: errMsg(e) }));
  const retry = useMutation({ mutationFn: () => unwrap(api.POST('/esign/requests/{id}/retry', { params: { path: { id } } })), onSuccess: () => after('m.esign.retried'), onError: fail });
  const cancel = useMutation({ mutationFn: () => unwrap(api.POST('/esign/requests/{id}/cancel', { params: { path: { id } } })), onSuccess: () => after('m.esign.cancelled'), onError: fail });
  const r = q.data;
  if (!online) return <View><Header theme={theme} title={t('m.esign.title')} onBack={onBack} /><OnlineOnly theme={theme} /></View>;
  if (!r) return <View><Header theme={theme} title={t('m.esign.title')} onBack={onBack} />{q.isError ? <Text style={s.muted}>{errMsg(q.error)}</Text> : <ActivityIndicator />}</View>;
  return (
    <View>
      <Header theme={theme} title={r.title} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Text style={s.muted}>{esignStatus(r.status)} · {t(r.mode === 'sequential' ? 'm.esign.sequential' : 'm.esign.parallel')}</Text>
      {r.items.map((i) => (
        <View key={i.id} style={{ marginTop: 12 }}>
          <Text style={s.text}>{i.documentName} · <Text style={{ color: i.status === 'failed' ? theme.status.overdue : i.status === 'signed' ? theme.status.done : theme.text }}>{t(`m.esign.item.${i.status}` as MessageKey)}</Text></Text>
          {i.error && <Text style={[s.muted, { color: theme.status.overdue }]}>{i.error}</Text>}
          {i.signers.map((sg) => <Text key={sg.id} style={s.muted}>• {sg.name} — {t(`m.esign.signer.${sg.status}` as MessageKey)}{sg.signedAt ? ` (${String(sg.signedAt).slice(0, 10)})` : ''}</Text>)}
        </View>
      ))}
      {perms.esignEdit && <View style={{ flexDirection: 'row', gap: 8 }}>
        {canRetryEsign(r.status, r.items.map((i) => i.status)) && <Pressable style={[s.button, { flex: 1 }]} disabled={retry.isPending} onPress={() => retry.mutate()} accessibilityRole="button">
          <Text style={s.buttonText}>{t('m.esign.retry')}</Text></Pressable>}
        {canCancelEsign(r.status) && <Pressable style={[s.ghost, { marginTop: 12 }]} disabled={cancel.isPending} accessibilityRole="button"
          onPress={() => Alert.alert(t('m.esign.cancel'), r.title, [{ text: t('common.cancel'), style: 'cancel' }, { text: t('m.esign.cancel'), style: 'destructive', onPress: () => cancel.mutate() }])}>
          <Text style={[s.ghostText, { color: theme.status.overdue }]}>{t('m.esign.cancel')}</Text></Pressable>}
      </View>}
    </View>
  );
}

// ---------------- Hub ----------------
export function PracticeHub({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const p = usePracticePerms();
  const hearings = useHearings();
  const todayCount = hearingsInRange(hearings, todayIST(), 1).length;
  const items: Array<[boolean, 'notices' | 'hearings' | 'dscList' | 'audit' | 'esignList', 'file-text' | 'calendar' | 'key' | 'clipboard' | 'edit-3', MessageKey]> = [
    [true, 'notices', 'file-text', 'm.notice.title'], [true, 'hearings', 'calendar', 'm.notice.hearings'],
    [true, 'dscList', 'key', 'm.dsc.title'], [p.audit, 'audit', 'clipboard', 'm.audit.title'], [p.esign, 'esignList', 'edit-3', 'm.esign.title'],
  ];
  return (
    <View>
      <Header theme={theme} title={t('m.notice.hub')} onBack={onBack} />
      {items.filter(([show]) => show).map(([, name, icon, label]) => (
        <Pressable key={name} style={[s.row, { minHeight: 48 }]} onPress={() => nav.push({ name })} accessibilityRole="button">
          <Feather name={icon} size={18} color={theme.primary} style={{ marginRight: 10 }} />
          <Text style={[s.text, { flex: 1 }]}>{t(label)}</Text>
          {name === 'hearings' && todayCount > 0 && <Text style={[s.chip, { marginRight: 6 }]}>{t('m.notice.todayCount', { count: todayCount })}</Text>}
          <Feather name="chevron-right" size={18} color={theme.textMuted} />
        </Pressable>
      ))}
    </View>
  );
}
