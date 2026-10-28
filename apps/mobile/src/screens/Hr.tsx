import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDaysIso, formatINR, type HrSettings } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { hasGrant, rupeesInputToPaise } from '../logic/billing';
import {
  attendanceView, balancesFrom, buildClaim, buildDraft, calendarOf, canCancelLeave, elapsed, fmtMinutes, groupWeek, isEditable, leavePreview, limitHint,
  runningTimer, todaysAttendance, toHolidays, toLeaveRequests, toLeaveTypes, toTimeItem, type DraftError, type ExpenseError, type ExpenseLineForm,
  type LeavePreviewError, type TimeItem,
} from '../logic/hr';
import { currentFy, todayIST } from '../logic/registers';
import { toTaskItem } from '../logic/tasks';
import { pickImage, uploadReceiptPhoto } from '../net';
import { api, unwrap, useSession } from '../session';
import { getEngine, syncNow, useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui, useTable } from '../ui';
import { Header } from './Header';
import type { Nav } from './Stack';

/* Phase 6 on Android (D84–D94). Offline: time drafts + check-in/out via the sync outbox. Online only: timer, submit, leave, expenses, approvals. */

const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')) }).data;
const userId = () => useSession.getState().tokens?.userId ?? '';
const errMsg = (e: unknown) => (e as { message?: string })?.message ?? t('common.error');

/** UI gating only (server enforces, D85/D86). Managers without an approve grant still see approvals when they have pending items. */
export function useHrPerms() {
  const g = useMe()?.grants;
  const own = (m: string) => hasGrant(g, m, 'edit') || hasGrant(g, m, 'create');
  return { time: own('time'), hr: own('hr'), approve: hasGrant(g, 'time', 'approve') || hasGrant(g, 'hr', 'approve') };
}

function Offline({ theme }: { theme: Theme }) {
  return <Text accessibilityRole="alert" style={ui(theme).alert}>{t('m.time.offlineOnly')}</Text>;
}
function Chip({ theme, on, label, onPress }: { theme: Theme; on: boolean; label: string; onPress(): void }) {
  const s = ui(theme);
  return (
    <Pressable onPress={onPress} style={[s.chipBtn, on && { backgroundColor: theme.primary, borderColor: theme.primary }]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
      <Text style={{ color: on ? theme.primaryText : theme.text }}>{label}</Text>
    </Pressable>
  );
}

// ---------------- hub ----------------

export function HrHub({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const p = useHrPerms();
  const online = useSync((x) => x.online);
  // Managers by reporting line have no grant: peek at pending items when online.
  const peek = useQuery({ queryKey: ['hr', 'approvalsPeek'], enabled: online && !p.approve, staleTime: 60_000,
    queryFn: async () => ((await unwrap(api.GET('/hr/leave/requests', { params: { query: { status: 'pending' } } }))) as unknown as Array<{ userId: string }>).some((x) => x.userId !== userId()) });
  const items: Array<{ route: Parameters<Nav['push']>[0]; icon: React.ComponentProps<typeof Feather>['name']; label: MessageKey; show: boolean }> = [
    { route: { name: 'timer' }, icon: 'clock', label: 'm.time.timer', show: p.time },
    { route: { name: 'myTime' }, icon: 'calendar', label: 'm.time.myTime', show: p.time },
    { route: { name: 'attendance' }, icon: 'map-pin', label: 'm.att.title', show: p.hr },
    { route: { name: 'leave' }, icon: 'sun', label: 'm.leave.title', show: p.hr },
    { route: { name: 'expenses' }, icon: 'shopping-bag', label: 'm.exp.title', show: p.hr },
    { route: { name: 'approvals' }, icon: 'check-circle', label: 'm.time.approvals', show: p.approve || !!peek.data },
  ];
  const shown = items.filter((x) => x.show);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.time.hub')} onBack={onBack} />
      {!shown.length && <Text style={s.muted}>{t('m.time.noAccess')}</Text>}
      {shown.map((x) => (
        <Pressable key={x.label} style={s.row} onPress={() => nav.push(x.route)} accessibilityRole="button">
          <Feather name={x.icon} size={18} color={theme.primary} style={{ marginRight: 10 }} />
          <Text style={[s.text, { flex: 1 }]}>{t(x.label)}</Text>
          <Feather name="chevron-right" size={18} color={theme.textMuted} />
        </Pressable>
      ))}
    </View>
  );
}

// ---------------- timer ----------------

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return now;
}
function useMyTasks() {
  const rows = useTable('task');
  const me = userId();
  return useMemo(() => rows.filter((r) => !r.deleted).map(toTaskItem).filter((x) => x.people.includes(me) && x.status !== 'done').slice(0, 12), [rows, me]);
}

export function Timer({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const timer = runningTimer(useTable('time_timer'), userId());
  const tasks = useMyTasks();
  const now = useNow();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [billable, setBillable] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => unwrap(api.POST('/time/timer/start', { body: { taskId, notes: notes.trim() || null, billable, deviceAt: new Date().toISOString() } })),
    onSuccess: () => { setMsg(null); void syncNow(); }, onError: (e) => setMsg(t('m.time.failed', { reason: errMsg(e) })),
  });
  const stop = useMutation({
    mutationFn: () => unwrap(api.POST('/time/timer/stop', { body: { notes: notes.trim() || null } })),
    onSuccess: (r) => { const x = r as { minutes?: number; capped?: boolean }; setMsg(t(x.capped ? 'm.time.stoppedCapped' : 'm.time.stopped', { duration: fmtMinutes(Number(x.minutes ?? 0)) })); setNotes(''); void syncNow(); },
    onError: (e) => setMsg(t('m.time.failed', { reason: errMsg(e) })),
  });
  const busy = start.isPending || stop.isPending;
  return (
    <View>
      <Header theme={theme} title={t('m.time.timer')} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {timer ? (
        <View style={{ alignItems: 'center', marginVertical: 16 }}>
          <Text style={[s.h1, { fontSize: 40, fontVariant: ['tabular-nums'] }]} accessibilityLabel={t('m.time.running')}>{elapsed(timer.startedAt, now)}</Text>
          <Text style={s.muted}>{timer.notes || tasks.find((x) => x.id === timer.taskId)?.title || t('m.time.running')}</Text>
        </View>
      ) : <Text style={[s.muted, { marginVertical: 12 }]}>{t('m.time.noTimer')}</Text>}
      {!timer && <>
        {!!tasks.length && <Text style={s.label}>{t('m.time.task')}</Text>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {tasks.map((x) => <Chip key={x.id} theme={theme} on={taskId === x.id} label={x.title} onPress={() => setTaskId(taskId === x.id ? null : x.id)} />)}
        </View>
        <View style={[s.row, { minHeight: 48 }]}>
          <Text style={[s.text, { flex: 1 }]}>{t('m.time.billable')}</Text>
          <Switch value={billable} onValueChange={setBillable} accessibilityLabel={t('m.time.billable')} />
        </View>
      </>}
      <Text style={s.label}>{t('m.time.notes')}</Text>
      <TextInput style={s.input} value={notes} onChangeText={setNotes} accessibilityLabel={t('m.time.notes')} maxLength={2000} />
      {online ? (
        <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => (timer ? stop.mutate() : start.mutate())} accessibilityRole="button">
          {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={s.buttonText}>{t(timer ? 'm.time.stop' : 'm.time.start')}</Text>}
        </Pressable>
      ) : <Text style={s.alert}>{t('m.time.timerOffline')}</Text>}
      <Pressable style={[s.ghost, { marginTop: 12 }]} onPress={() => nav.push({ name: 'timeEntry' })} accessibilityRole="button">
        <Feather name="plus" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.time.logManual')}</Text>
      </Pressable>
    </View>
  );
}

// ---------------- my time ----------------

function useMyEntries(): TimeItem[] {
  const rows = useTable('time_entry');
  return useMemo(() => rows.filter((r) => !r.deleted).map(toTimeItem), [rows]);
}
const STATUS_COLOR = (th: Theme, st: string) => (st === 'approved' ? th.status.done : st === 'rejected' ? th.status.overdue : st === 'submitted' ? th.status.inProgress : th.textMuted);

export function MyTime({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const pending = useSync((x) => x.pending);
  const entries = useMyEntries();
  const today = todayIST();
  const [anchor, setAnchor] = useState(today);
  const week = useMemo(() => groupWeek(entries, anchor, userId()), [entries, anchor]);
  const [msg, setMsg] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: async () => { await syncNow(); return unwrap(api.POST('/time/timesheets/submit', { body: { weekStart: week.weekStart } })); },
    onSuccess: (r) => { setMsg(t('m.time.submitted', { count: Number((r as { submitted?: number }).submitted ?? 0) })); void syncNow(); },
    onError: (e) => setMsg(t('m.time.failed', { reason: errMsg(e) })),
  });
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.time.myTime')} onBack={onBack} right={
        <Pressable style={s.ghost} onPress={() => nav.push({ name: 'timeEntry' })} accessibilityRole="button" accessibilityLabel={t('m.time.add')}>
          <Feather name="plus" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.time.add')}</Text></Pressable>} />
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable style={s.icon} onPress={() => setAnchor(addDaysIso(week.weekStart, -7))} accessibilityRole="button" accessibilityLabel={t('m.time.prevWeek')}>
          <Feather name="chevron-left" size={22} color={theme.text} /></Pressable>
        <Text style={[s.text, { flex: 1, textAlign: 'center' }]}>{t('m.time.week', { from: week.weekStart, to: week.weekEnd })}</Text>
        <Pressable style={s.icon} disabled={week.weekEnd >= today} onPress={() => setAnchor(addDaysIso(week.weekStart, 7))} accessibilityRole="button" accessibilityLabel={t('m.time.nextWeek')}>
          <Feather name="chevron-right" size={22} color={week.weekEnd >= today ? theme.border : theme.text} /></Pressable>
      </View>
      <Text style={s.muted}>{t('m.time.totals', { total: fmtMinutes(week.totalMinutes), billable: fmtMinutes(week.billableMinutes) })}</Text>
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <FlatList data={week.days} keyExtractor={(d) => d.date} renderItem={({ item: d }) => (
        <View>
          <Text style={s.h2}>{d.date} · {fmtMinutes(d.minutes)}</Text>
          {d.entries.map((e) => (
            <Pressable key={e.id} style={s.row} disabled={!isEditable(e)} onPress={() => nav.push({ name: 'timeEntry', id: e.id })} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Text style={s.text} numberOfLines={1}>{e.notes || t('m.time.noNotes')}</Text>
                <Text style={s.muted}>{[t(`m.time.status.${e.status}`), e.billable ? t('m.time.billable') : t('m.time.nonBillable'), e.capped ? t('m.time.capped') : null, e.decisionNote].filter(Boolean).join(' · ')}</Text>
              </View>
              <Text style={[s.text, { color: STATUS_COLOR(theme, e.status) }]}>{fmtMinutes(e.minutes)}</Text>
            </Pressable>
          ))}
        </View>
      )} />
      {week.submittable && (online
        ? <Pressable style={[s.button, submit.isPending && { opacity: 0.5 }]} disabled={submit.isPending} onPress={() => submit.mutate()} accessibilityRole="button">
          <Text style={s.buttonText}>{t('m.time.submitWeek', { count: week.draftCount })}</Text></Pressable>
        : <Text style={s.alert}>{t('m.time.submitOffline')}</Text>)}
      {!!pending && <Text style={s.muted}>{t('sync.pending', { count: pending })}</Text>}
    </View>
  );
}

const DRAFT_ERR: Record<DraftError, MessageKey> = { date: 'm.time.err.date', future: 'm.time.err.future', duration: 'm.time.err.duration', dayCap: 'm.time.err.dayCap', notes: 'm.time.err.notes' };

/** Add/edit a draft — works offline (sync outbox); the server re-validates (D89). */
export function TimeEntryForm({ theme, nav, id, onBack }: { theme: Theme; nav: Nav; id?: string; onBack?: () => void }) {
  const s = ui(theme);
  const entries = useMyEntries();
  const tasks = useMyTasks();
  const cur = id ? entries.find((e) => e.id === id) : undefined;
  const [workDate, setWorkDate] = useState(todayIST());
  const [duration, setDuration] = useState('');
  const [notes, setNotes] = useState('');
  const [billable, setBillable] = useState(true);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [errors, setErrors] = useState<DraftError[]>([]);
  const [loaded, setLoaded] = useState(!id);
  useEffect(() => {
    if (loaded || !cur) return;
    setWorkDate(cur.workDate); setDuration(`${Math.floor(cur.minutes / 60)}:${String(cur.minutes % 60).padStart(2, '0')}`);
    setNotes(cur.notes); setBillable(cur.billable); setTaskId(cur.taskId); setLoaded(true);
  }, [cur, loaded]);
  if (id && cur && !isEditable(cur)) return <View><Header theme={theme} title={t('m.time.entry')} onBack={onBack} /><Text style={s.muted}>{t('m.time.locked')}</Text></View>;
  async function save() {
    const task = tasks.find((x) => x.id === taskId);
    const r = buildDraft({ workDate, duration, notes, billable, taskId, clientId: task?.clientId ?? cur?.clientId ?? null }, todayIST(), entries.filter((e) => e.id !== id && e.userId === userId()));
    if (!r.ok) { setErrors(r.errors); return; }
    const engine = getEngine();
    if (!engine) return;
    await engine.write('time_entry', id ?? Crypto.randomUUID(), r.patch);
    void syncNow(); nav.pop();
  }
  async function remove() {
    if (!id) return;
    Alert.alert(t('m.time.delete'), '', [{ text: t('common.cancel'), style: 'cancel' }, { text: t('m.time.delete'), style: 'destructive',
      onPress: async () => { await getEngine()?.write('time_entry', id, {}, { delete: true }); void syncNow(); nav.pop(); } }]);
  }
  return (
    <View>
      <Header theme={theme} title={t(id ? 'm.time.editEntry' : 'm.time.newEntry')} onBack={onBack} />
      <Text style={s.muted}>{t('m.time.draftHint')}</Text>
      {!!errors.length && <Text accessibilityRole="alert" style={s.alert}>{errors.map((e) => t(DRAFT_ERR[e])).join('\n')}</Text>}
      <Text style={s.label}>{t('m.time.date')}</Text>
      <TextInput style={s.input} value={workDate} onChangeText={setWorkDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.time.date')} />
      <Text style={s.label}>{t('m.time.duration')}</Text>
      <TextInput style={s.input} value={duration} onChangeText={setDuration} placeholder="1:30" placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.time.duration')} />
      {!!tasks.length && <Text style={s.label}>{t('m.time.task')}</Text>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {tasks.map((x) => <Chip key={x.id} theme={theme} on={taskId === x.id} label={x.title} onPress={() => setTaskId(taskId === x.id ? null : x.id)} />)}
      </View>
      <Text style={s.label}>{t('m.time.notes')}</Text>
      <TextInput style={[s.input, { minHeight: 72 }]} multiline value={notes} onChangeText={setNotes} accessibilityLabel={t('m.time.notes')} maxLength={2000} />
      <View style={[s.row, { minHeight: 48 }]}>
        <Text style={[s.text, { flex: 1 }]}>{t('m.time.billable')}</Text>
        <Switch value={billable} onValueChange={setBillable} accessibilityLabel={t('m.time.billable')} />
      </View>
      <Pressable style={s.button} onPress={() => void save()} accessibilityRole="button"><Text style={s.buttonText}>{t('m.time.saveDraft')}</Text></Pressable>
      {id && <Pressable style={[s.ghost, { marginTop: 12 }]} onPress={() => void remove()} accessibilityRole="button">
        <Text style={[s.ghostText, { color: theme.status.overdue }]}>{t('m.time.delete')}</Text></Pressable>}
    </View>
  );
}

// ---------------- attendance ----------------

const istOf = (iso: string) => todayIST(new Date(iso));
const FLAGS = ['no_location', 'out_of_fence', 'ip_unknown', 'ip_not_allowed', 'clock_skew', 'minutes_capped'];

/**
 * Check-in/out via the sync outbox (insert = check-in, update = check-out; server stamps time, fence and skew — D88/D89).
 * Location: foreground permission is asked at check-in/out; coordinates are rounded to 4 dp before leaving the device.
 * Refused permission or no fix within 10 s sends nulls and the server flags the day per firm policy.
 */
export function Attendance({ theme, onBack }: { theme: Theme; onBack?: () => void }) {
  const s = ui(theme);
  const rows = useTable('attendance');
  const today = todayIST();
  const a = todaysAttendance(rows, today, istOf);
  const v = attendanceView(a);
  const [busy, setBusy] = useState(false);
  const recent = useMemo(() => rows.filter((r) => !r.deleted).map((r) => ({ id: r.id, d: String(r.fields.work_date ?? '').slice(0, 10), m: Number(r.fields.minutes ?? 0), st: String(r.fields.status ?? '') }))
    .filter((x) => x.d && x.d !== today).sort((x, y) => y.d.localeCompare(x.d)).slice(0, 14), [rows, today]);
  /** Current position rounded to 4 dp (~11 m), or nulls if permission is refused or no fix arrives in time. */
  async function coords(): Promise<{ lat: number | null; lng: number | null }> {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return { lat: null, lng: null };
      const fix = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
      ]);
      if (!fix) return { lat: null, lng: null };
      const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
      return { lat: r4(fix.coords.latitude), lng: r4(fix.coords.longitude) };
    } catch { return { lat: null, lng: null }; }
  }
  async function act() {
    const engine = getEngine();
    if (!engine || busy) return;
    setBusy(true);
    try {
      const at = new Date().toISOString();
      const { lat, lng } = await coords();
      if (v.phase === 'none') await engine.write('attendance', Crypto.randomUUID(), { device_check_in_at: at, in_lat: lat, in_lng: lng, notes: null });
      else if (a && v.phase === 'in') await engine.write('attendance', a.id, { device_check_out_at: at, out_lat: lat, out_lng: lng });
      void syncNow();
    } finally { setBusy(false); }
  }
  const toneColor = v.tone === 'ok' ? theme.status.done : v.tone === 'bad' ? theme.status.overdue : v.tone === 'warn' ? theme.status.dueSoon : theme.textMuted;
  const fmtTime = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(11, 16) : '—');
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.att.title')} onBack={onBack} />
      <Text style={s.muted}>{t('m.att.privacy')}</Text>
      <View style={{ padding: 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}>
        <Text style={s.text}>{today}</Text>
        <Text style={[s.text, { color: toneColor, fontWeight: '600' }]}>{t(`m.att.status.${v.statusKey}`)}</Text>
        {a && <Text style={s.muted}>{t('m.att.times', { in: fmtTime(a.checkInAt ?? a.deviceCheckInAt), out: fmtTime(a.checkOutAt ?? a.deviceCheckOutAt) })}</Text>}
        {!!a?.minutes && <Text style={s.muted}>{fmtMinutes(a.minutes)}</Text>}
        {!v.synced && <Text style={s.muted}>{t('m.att.waitingSync')}</Text>}
        {v.pendingOut && <Text style={s.muted}>{t('m.att.outPending')}</Text>}
        {v.flags.map((f) => <Text key={f} style={[s.chip, { marginTop: 4, alignSelf: 'flex-start' }]}>{FLAGS.includes(f) ? t(`m.att.flag.${f}` as MessageKey) : f}</Text>)}
      </View>
      {v.phase !== 'out' && <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void act()} accessibilityRole="button">
        <Text style={s.buttonText}>{t(v.phase === 'none' ? 'm.att.checkIn' : 'm.att.checkOut')}</Text></Pressable>}
      <Text style={s.muted}>{t('m.att.noLocation')}</Text>
      <Text style={s.h2}>{t('m.att.recent')}</Text>
      <FlatList data={recent} keyExtractor={(x) => x.id} ListEmptyComponent={<Text style={s.muted}>{t('m.att.none')}</Text>} renderItem={({ item }) => (
        <View style={s.row}><Text style={[s.text, { flex: 1 }]}>{item.d}</Text><Text style={s.muted}>{[item.m ? fmtMinutes(item.m) : null, item.st].filter(Boolean).join(' · ')}</Text></View>
      )} />
    </View>
  );
}

// ---------------- leave ----------------

function useLeaveData() {
  const types = toLeaveTypes(useTable('leave_type'));
  const requests = toLeaveRequests(useTable('leave_request'));
  const ledger = useTable('leave_ledger');
  const holidays = toHolidays(useTable('holiday'));
  const today = todayIST();
  const balances = useMemo(() => balancesFrom(ledger, requests, types, today), [ledger, requests, types, today]);
  return { types, requests, holidays, balances, today };
}

export function Leave({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const { types, requests, balances, today } = useLeaveData();
  const name = (id: string) => types.find((x) => x.id === id)?.name ?? '—';
  const [msg, setMsg] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/hr/leave/requests/{id}/cancel', { params: { path: { id } } })),
    onSuccess: () => { setMsg(t('m.leave.cancelled')); void syncNow(); }, onError: (e) => setMsg(t('m.time.failed', { reason: errMsg(e) })),
  });
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.leave.title')} onBack={onBack} right={online ? (
        <Pressable style={s.ghost} onPress={() => nav.push({ name: 'leaveApply' })} accessibilityRole="button">
          <Feather name="plus" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.leave.apply')}</Text></Pressable>) : undefined} />
      {!online && <Offline theme={theme} />}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Text style={s.h2}>{t('m.leave.balances')}</Text>
      {!balances.length && <Text style={s.muted}>{t('m.leave.noBalances')}</Text>}
      {balances.map((b) => (
        <View key={b.leaveTypeId} style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.text}>{name(b.leaveTypeId)}</Text>
            <Text style={s.muted}>{t('m.leave.balanceLine', { balance: b.balance, pending: b.pending })}</Text>
            {b.expiring.map((x) => <Text key={x.expiresOn} style={s.muted}>{t('m.leave.expiring', { days: x.days, date: x.expiresOn })}</Text>)}
          </View>
          <Text style={[s.h1, { fontSize: 18 }]} accessibilityLabel={t('m.leave.available')}>{b.available}</Text>
        </View>
      ))}
      <Text style={s.h2}>{t('m.leave.requests')}</Text>
      <FlatList data={requests} keyExtractor={(x) => x.id} ListEmptyComponent={<Text style={s.muted}>{t('m.leave.noRequests')}</Text>} renderItem={({ item: r }) => (
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.text}>{name(r.leaveTypeId)} · {r.from}{r.to !== r.from ? ` → ${r.to}` : ''}</Text>
            <Text style={s.muted}>{[t('m.leave.days', { days: r.approvedDays ?? r.days }), t(`m.leave.status.${r.status}` as MessageKey), r.decisionNote].filter(Boolean).join(' · ')}</Text>
          </View>
          {online && canCancelLeave(r, today) && <Pressable style={s.ghost} disabled={cancel.isPending} accessibilityRole="button"
            onPress={() => Alert.alert(t('m.leave.cancel'), '', [{ text: t('common.cancel'), style: 'cancel' }, { text: t('m.leave.cancel'), style: 'destructive', onPress: () => cancel.mutate(r.id) }])}>
            <Text style={[s.ghostText, { color: theme.status.overdue }]}>{t('m.leave.cancel')}</Text></Pressable>}
        </View>
      )} />
    </View>
  );
}

const LEAVE_ERR: Record<LeavePreviewError, MessageKey> = {
  type: 'm.leave.err.type', date: 'm.leave.err.date', order: 'm.leave.err.order', halves: 'm.leave.err.halves', halfNotAllowed: 'm.leave.err.halfNotAllowed',
  noDays: 'm.leave.err.noDays', maxDays: 'm.leave.err.maxDays', balance: 'm.leave.err.balance',
};

export function LeaveApply({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const { types, holidays, balances, today } = useLeaveData();
  const settings = useQuery({ queryKey: ['hr', 'settings'], enabled: online, staleTime: 3_600_000, queryFn: async () => (await unwrap(api.GET('/hr/settings'))) as Partial<HrSettings> }).data;
  const cal = useMemo(() => calendarOf(holidays, settings), [holidays, settings]);
  const [leaveTypeId, setType] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [startHalf, setStartHalf] = useState(false);
  const [endHalf, setEndHalf] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const type = types.find((x) => x.id === leaveTypeId);
  const avail = balances.find((b) => b.leaveTypeId === leaveTypeId)?.available ?? null;
  const p = leavePreview({ leaveTypeId, from, to, startHalf, endHalf, reason }, cal, holidays, type, avail);
  const qcl = useQueryClient();
  const apply = useMutation({
    mutationFn: () => unwrap(api.POST('/hr/leave/requests', { body: { leaveTypeId, from, to, startHalf, endHalf, reason: reason.trim() || null } })),
    onSuccess: () => { void syncNow(); void qcl.invalidateQueries({ queryKey: ['hr'] }); Alert.alert(t('m.leave.applied')); nav.pop(); },
    onError: (e) => setMsg(t('m.time.failed', { reason: errMsg(e) })),
  });
  return (
    <View>
      <Header theme={theme} title={t('m.leave.apply')} onBack={onBack} />
      {!online && <Offline theme={theme} />}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Text style={s.label}>{t('m.leave.type')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {types.map((x) => <Chip key={x.id} theme={theme} on={leaveTypeId === x.id} label={x.name} onPress={() => setType(x.id)} />)}
      </View>
      {avail !== null && <Text style={s.muted}>{t('m.leave.availableN', { days: avail })}</Text>}
      <Text style={s.label}>{t('m.leave.from')}</Text>
      <TextInput style={s.input} value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.leave.from')} />
      <Text style={s.label}>{t('m.leave.to')}</Text>
      <TextInput style={s.input} value={to} onChangeText={setTo} placeholder="YYYY-MM-DD" placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.leave.to')} />
      {(!type || type.allowHalfDay) && <>
        <View style={[s.row, { minHeight: 48 }]}><Text style={[s.text, { flex: 1 }]}>{t('m.leave.startHalf')}</Text><Switch value={startHalf} onValueChange={setStartHalf} accessibilityLabel={t('m.leave.startHalf')} /></View>
        <View style={[s.row, { minHeight: 48 }]}><Text style={[s.text, { flex: 1 }]}>{t('m.leave.endHalf')}</Text><Switch value={endHalf} onValueChange={setEndHalf} accessibilityLabel={t('m.leave.endHalf')} /></View>
      </>}
      <Text style={s.label}>{t('m.leave.reason')}</Text>
      <TextInput style={[s.input, { minHeight: 72 }]} multiline value={reason} onChangeText={setReason} maxLength={1000} accessibilityLabel={t('m.leave.reason')} />
      <View style={{ marginTop: 12, padding: 10, borderRadius: 6, backgroundColor: theme.surfaceAlt }}>
        <Text style={s.text}>{t('m.leave.preview', { days: p.days })}</Text>
        {p.skipped.map((x) => <Text key={x.date} style={s.muted}>{x.date} · {x.why === 'weekend' ? t('m.leave.weekend') : x.name ?? t('m.leave.holiday')}</Text>)}
        {p.errors.map((e) => <Text key={e} style={[s.muted, { color: theme.status.overdue }]}>{t(LEAVE_ERR[e])}</Text>)}
        <Text style={s.muted}>{t('m.leave.serverCounts')}</Text>
      </View>
      <Pressable style={[s.button, (!online || p.errors.length > 0 || apply.isPending) && { opacity: 0.5 }]} disabled={!online || p.errors.length > 0 || apply.isPending}
        onPress={() => apply.mutate()} accessibilityRole="button"><Text style={s.buttonText}>{t('m.leave.submit')}</Text></Pressable>
    </View>
  );
}

// ---------------- expenses (online only, D89) ----------------

type Claim = { id: string; title: string; status: string; claimedPaise: number; approvedPaise: number | null; paidPaise: number; userName?: string | null; userId?: string };

export function Expenses({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const me = userId();
  const q = useQuery({ queryKey: ['hr', 'claims', me], enabled: online, queryFn: async () => (await unwrap(api.GET('/hr/expenses/claims', { params: { query: { userId: me } } }))) as unknown as Claim[] });
  const qcl = useQueryClient();
  const submit = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/hr/expenses/claims/{id}/submit', { params: { path: { id } } })),
    onSuccess: () => qcl.invalidateQueries({ queryKey: ['hr', 'claims'] }), onError: (e) => Alert.alert(t('m.time.failed', { reason: errMsg(e) })),
  });
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.exp.title')} onBack={onBack} right={online ? (
        <Pressable style={s.ghost} onPress={() => nav.push({ name: 'expenseForm' })} accessibilityRole="button">
          <Feather name="plus" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.exp.new')}</Text></Pressable>) : undefined} />
      {!online ? <Offline theme={theme} /> : q.isLoading ? <ActivityIndicator /> : (
        <FlatList data={q.data ?? []} keyExtractor={(x) => x.id} ListEmptyComponent={<Text style={s.muted}>{t('m.exp.none')}</Text>} renderItem={({ item: c }) => (
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.text}>{c.title}</Text>
              <Text style={s.muted}>{[t(`m.exp.status.${c.status}` as MessageKey), c.approvedPaise != null ? t('m.exp.approvedAmt', { amount: formatINR(c.approvedPaise) }) : null].filter(Boolean).join(' · ')}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.text}>{formatINR(c.claimedPaise)}</Text>
              {c.status === 'draft' && <Pressable style={s.ghost} onPress={() => submit.mutate(c.id)} disabled={submit.isPending} accessibilityRole="button"><Text style={s.ghostText}>{t('m.exp.submit')}</Text></Pressable>}
            </View>
          </View>
        )} />
      )}
    </View>
  );
}

type Cat = { key: string; name: string; limitPaise?: number | null; limitMode?: string; active?: boolean };
const EXP_ERR: Record<ExpenseError, MessageKey> = {
  title: 'm.exp.err.title', noLines: 'm.exp.err.noLines', category: 'm.exp.err.category', date: 'm.exp.err.date', future: 'm.exp.err.future',
  description: 'm.exp.err.description', amount: 'm.exp.err.amount',
};
const blankLine = (): ExpenseLineForm & { uri?: string; uploading?: boolean } => ({ categoryKey: '', spentOn: todayIST(), description: '', amount: '', receiptDocId: null });

export function ExpenseForm({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const cats = useQuery({ queryKey: ['hr', 'categories'], enabled: online, queryFn: async () => ((await unwrap(api.GET('/hr/expense-categories'))) as unknown as Cat[]).filter((c) => c.active !== false) }).data ?? [];
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState([blankLine()]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qcl = useQueryClient();
  const set = (i: number, patch: Partial<ReturnType<typeof blankLine>>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  async function attach(i: number, src: 'camera' | 'library') {
    let f = await pickImage(src);
    if (f === 'denied') { setMsg(t('m.doc.noPermission')); f = await pickImage('library'); }
    if (!f || f === 'denied') return;
    set(i, { uri: f.uri, uploading: true });
    try { set(i, { receiptDocId: await uploadReceiptPhoto(f, currentFy(), t('m.exp.receiptCategory')), uploading: false }); }
    catch (e) { set(i, { uri: undefined, uploading: false }); setMsg(t('m.doc.uploadFailed', { reason: errMsg(e) })); }
  }
  async function save(submitNow: boolean) {
    const r = buildClaim(title, lines, todayIST());
    if (!r.ok) { setMsg(r.errors.map((e) => (e.line === null ? '' : t('m.exp.lineN', { n: e.line + 1 }) + ': ') + t(EXP_ERR[e.error])).join('\n')); return; }
    setBusy(true); setMsg(null);
    try {
      const res = (await unwrap(api.POST('/hr/expenses/claims', { body: { ...r.body, submit: submitNow } as never }))) as { warnings?: string[] };
      void qcl.invalidateQueries({ queryKey: ['hr', 'claims'] });
      Alert.alert(t(submitNow ? 'm.exp.submitted' : 'm.exp.saved'), res.warnings?.length ? t('m.exp.warnings', { count: res.warnings.length }) : undefined);
      nav.pop();
    } catch (e) { setMsg(t('m.time.failed', { reason: errMsg(e) })); } finally { setBusy(false); }
  }
  const total = lines.reduce((a, l) => a + (rupeesInputToPaise(l.amount) ?? 0), 0);
  const uploading = lines.some((l) => l.uploading);
  return (
    <View>
      <Header theme={theme} title={t('m.exp.new')} onBack={onBack} />
      {!online && <Offline theme={theme} />}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Text style={s.label}>{t('m.exp.claimTitle')}</Text>
      <TextInput style={s.input} value={title} onChangeText={setTitle} maxLength={200} accessibilityLabel={t('m.exp.claimTitle')} />
      {lines.map((l, i) => {
        const cat = cats.find((c) => c.key === l.categoryKey);
        const hint = limitHint(rupeesInputToPaise(l.amount), cat);
        return (
          <View key={i} style={{ marginTop: 16, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[s.text, { flex: 1, fontWeight: '600' }]}>{t('m.exp.lineN', { n: i + 1 })}</Text>
              {lines.length > 1 && <Pressable style={s.icon} onPress={() => setLines((ls) => ls.filter((_, k) => k !== i))} accessibilityRole="button" accessibilityLabel={t('m.exp.removeLine')}>
                <Feather name="trash-2" size={18} color={theme.status.overdue} /></Pressable>}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {cats.map((c) => <Chip key={c.key} theme={theme} on={l.categoryKey === c.key} label={c.name} onPress={() => set(i, { categoryKey: c.key })} />)}
            </View>
            <Text style={s.label}>{t('m.exp.spentOn')}</Text>
            <TextInput style={s.input} value={l.spentOn} onChangeText={(v) => set(i, { spentOn: v })} accessibilityLabel={t('m.exp.spentOn')} />
            <Text style={s.label}>{t('m.exp.description')}</Text>
            <TextInput style={s.input} value={l.description} onChangeText={(v) => set(i, { description: v })} maxLength={500} accessibilityLabel={t('m.exp.description')} />
            <Text style={s.label}>{t('m.exp.amount')}</Text>
            <TextInput style={s.input} value={l.amount} onChangeText={(v) => set(i, { amount: v })} keyboardType="decimal-pad" accessibilityLabel={t('m.exp.amount')} />
            {hint && <Text style={[s.muted, { color: hint === 'block' ? theme.status.overdue : theme.text }]}>{t(hint === 'block' ? 'm.exp.overLimitBlock' : 'm.exp.overLimitWarn', { limit: formatINR(cat?.limitPaise ?? 0) })}</Text>}
            {l.uri && <Image source={{ uri: l.uri }} style={{ width: '100%', height: 140, resizeMode: 'contain', marginTop: 8, backgroundColor: theme.surfaceAlt }} accessibilityIgnoresInvertColors />}
            {l.uploading ? <ActivityIndicator style={{ marginTop: 8 }} /> : (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Pressable style={s.ghost} onPress={() => void attach(i, 'camera')} accessibilityRole="button"><Feather name="camera" size={16} color={theme.primary} /><Text style={s.ghostText}>{t(l.receiptDocId ? 'm.exp.replaceReceipt' : 'm.exp.receipt')}</Text></Pressable>
                <Pressable style={s.ghost} onPress={() => void attach(i, 'library')} accessibilityRole="button"><Feather name="image" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.doc.library')}</Text></Pressable>
              </View>)}
          </View>
        );
      })}
      <Pressable style={[s.ghost, { marginTop: 12 }]} onPress={() => setLines((ls) => [...ls, blankLine()])} accessibilityRole="button">
        <Feather name="plus" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.exp.addLine')}</Text></Pressable>
      <Text style={[s.h2]}>{t('m.exp.total', { amount: formatINR(total) })}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable style={[s.ghost, { flex: 1, marginTop: 12 }, (busy || uploading || !online) && { opacity: 0.5 }]} disabled={busy || uploading || !online} onPress={() => void save(false)} accessibilityRole="button">
          <Text style={s.ghostText}>{t('m.exp.saveDraft')}</Text></Pressable>
        <Pressable style={[s.button, { flex: 1 }, (busy || uploading || !online) && { opacity: 0.5 }]} disabled={busy || uploading || !online} onPress={() => void save(true)} accessibilityRole="button">
          <Text style={s.buttonText}>{t('m.exp.submit')}</Text></Pressable>
      </View>
    </View>
  );
}

// ---------------- approvals (online, REST; never one's own — D86) ----------------

type PendingTime = { id: string; userId: string; userName: string | null; workDate: string; minutes: number; notes: string | null; clientName: string | null; taskTitle: string | null };
type PendingLeave = { id: string; userId: string; userName: string | null; from: string; to: string; days: number; leaveTypeKey: string | null; reason: string | null };

export function Approvals({ theme, onBack }: { theme: Theme; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const me = userId();
  const [tab, setTab] = useState<'time' | 'leave' | 'exp'>('time');
  const [msg, setMsg] = useState<string | null>(null);
  const qcl = useQueryClient();
  const time = useQuery({ queryKey: ['hr', 'appr', 'time'], enabled: online && tab === 'time',
    queryFn: async () => ((await unwrap(api.GET('/time/entries', { params: { query: { status: 'submitted' } } }))) as { items: PendingTime[] }).items.filter((x) => x.userId !== me) });
  const leave = useQuery({ queryKey: ['hr', 'appr', 'leave'], enabled: online && tab === 'leave',
    queryFn: async () => ((await unwrap(api.GET('/hr/leave/requests', { params: { query: { status: 'pending' } } }))) as unknown as PendingLeave[]).filter((x) => x.userId !== me) });
  const exp = useQuery({ queryKey: ['hr', 'appr', 'exp'], enabled: online && tab === 'exp',
    queryFn: async () => ((await unwrap(api.GET('/hr/expenses/claims', { params: { query: { status: 'submitted' } } }))) as unknown as Claim[]).filter((x) => x.userId !== me) });
  const done = (r?: unknown) => {
    const skipped = (r as { skipped?: unknown[] } | undefined)?.skipped?.length ?? 0;
    setMsg(skipped ? t('m.time.decidedSkipped', { count: skipped }) : t('m.time.decided'));
    void qcl.invalidateQueries({ queryKey: ['hr', 'appr'] });
  };
  const fail = (e: unknown) => setMsg(t('m.time.failed', { reason: errMsg(e) }));
  const decideTime = useMutation({ mutationFn: (v: { ids: string[]; approve: boolean }) => unwrap(api.POST('/time/entries/decide', { body: { ...v, note: null } })), onSuccess: done, onError: fail });
  const decideLeave = useMutation({ mutationFn: (v: { id: string; approve: boolean }) => unwrap(api.POST('/hr/leave/requests/{id}/decide', { params: { path: { id: v.id } }, body: { approve: v.approve } as never })), onSuccess: () => done(), onError: fail });
  const decideExp = useMutation({ mutationFn: (v: { id: string; approve: boolean }) => unwrap(api.POST('/hr/expenses/claims/{id}/decide', { params: { path: { id: v.id } }, body: { approve: v.approve } as never })), onSuccess: () => done(), onError: fail });
  const confirm = (approve: boolean, run: () => void) => (approve ? run() : Alert.alert(t('m.time.reject'), '', [{ text: t('common.cancel'), style: 'cancel' }, { text: t('m.time.reject'), style: 'destructive', onPress: run }]));
  const Actions = ({ onDecide }: { onDecide(approve: boolean): void }) => (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      <Pressable style={s.ghost} onPress={() => confirm(false, () => onDecide(false))} accessibilityRole="button" accessibilityLabel={t('m.time.reject')}><Feather name="x" size={18} color={theme.status.overdue} /></Pressable>
      <Pressable style={s.ghost} onPress={() => onDecide(true)} accessibilityRole="button" accessibilityLabel={t('m.time.approve')}><Feather name="check" size={18} color={theme.status.done} /></Pressable>
    </View>
  );
  const q = tab === 'time' ? time : tab === 'leave' ? leave : exp;
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.time.approvals')} onBack={onBack} />
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
        {(['time', 'leave', 'exp'] as const).map((k) => <Chip key={k} theme={theme} on={tab === k} label={t(k === 'time' ? 'm.time.title' : k === 'leave' ? 'm.leave.title' : 'm.exp.title')} onPress={() => setTab(k)} />)}
      </View>
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {!online ? <Offline theme={theme} /> : q.isLoading ? <ActivityIndicator /> : q.isError ? <Text style={s.muted}>{errMsg(q.error)}</Text> : (
        <ScrollView>
          {tab === 'time' && !!time.data?.length && <Pressable style={[s.button, { marginTop: 0, marginBottom: 8 }]} onPress={() => decideTime.mutate({ ids: time.data!.map((x) => x.id), approve: true })} accessibilityRole="button">
            <Text style={s.buttonText}>{t('m.time.approveAll', { count: time.data.length })}</Text></Pressable>}
          {tab === 'time' && time.data?.map((e) => (
            <View key={e.id} style={s.row}>
              <View style={{ flex: 1 }}><Text style={s.text}>{e.userName ?? '—'} · {e.workDate} · {fmtMinutes(Number(e.minutes))}</Text>
                <Text style={s.muted} numberOfLines={2}>{[e.clientName, e.taskTitle, e.notes].filter(Boolean).join(' · ')}</Text></View>
              <Actions onDecide={(approve) => decideTime.mutate({ ids: [e.id], approve })} />
            </View>))}
          {tab === 'leave' && leave.data?.map((r) => (
            <View key={r.id} style={s.row}>
              <View style={{ flex: 1 }}><Text style={s.text}>{r.userName ?? '—'} · {r.leaveTypeKey ?? ''}</Text>
                <Text style={s.muted}>{r.from} → {r.to} · {t('m.leave.days', { days: r.days })}{r.reason ? ` · ${r.reason}` : ''}</Text></View>
              <Actions onDecide={(approve) => decideLeave.mutate({ id: r.id, approve })} />
            </View>))}
          {tab === 'exp' && exp.data?.map((c) => (
            <View key={c.id} style={s.row}>
              <View style={{ flex: 1 }}><Text style={s.text}>{c.userName ?? '—'} · {c.title}</Text><Text style={s.muted}>{formatINR(c.claimedPaise)}</Text></View>
              <Actions onDecide={(approve) => decideExp.mutate({ id: c.id, approve })} />
            </View>))}
          {!(q.data as unknown[] | undefined)?.length && <Text style={s.muted}>{t('m.time.nothingToApprove')}</Text>}
          <Text style={[s.muted, { marginTop: 12 }]}>{t('m.time.approveWebHint')}</Text>
        </ScrollView>
      )}
    </View>
  );
}

