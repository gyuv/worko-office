import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { parseQuickTask } from '@worko/domain';
import { formatDate } from '@worko/i18n';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useReduceMotion } from '../glass';
import { changeError, matchClient, myDayGroups, type TaskItem } from '../logic/tasks';
import { todayIST } from '../logic/registers';
import { api, unwrap, useSession } from '../session';
import { getEngine, syncNow } from '../sync';
import { alpha, type Theme } from '../theme';
import { t, ui } from '../ui';
import { useClientItems } from './Clients';
import { useTasks } from './Tasks';

const useUserId = () => useSession((x) => x.tokens?.userId ?? '');
type Snack = { text: string; undo?: () => void } | null;

/** One-tap daily list: tick finishes, moon pushes to tomorrow; both undoable. Works offline (sync outbox). */
export function MyDayCard({ theme, onOpen }: { theme: Theme; onOpen(id: string): void }) {
  const s = ui(theme);
  const userId = useUserId();
  const tasks = useTasks();
  const g = useMemo(() => myDayGroups(tasks, userId, todayIST()), [tasks, userId]);
  const [snack, setSnack] = useState<Snack>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const show = (x: Snack) => { setSnack(x); clearTimeout(timer.current); timer.current = setTimeout(() => setSnack(null), 5000); };
  useEffect(() => () => clearTimeout(timer.current), []);

  const write = async (id: string, patch: Record<string, unknown>) => { await getEngine()?.write('task', id, patch); void syncNow(); };
  const complete = (x: TaskItem) => {
    if (changeError(x, { status: 'done' })) { show({ text: t('myday.needsDetail') }); onOpen(x.id); return; }
    const prev = x.status;
    void write(x.id, { status: 'done' });
    show({ text: t('myday.done', { title: x.title }), undo: () => void write(x.id, { status: prev }) });
  };
  const snooze = (x: TaskItem) => {
    const prev = x.actBy;
    void write(x.id, { act_by: g.tomorrow });
    show({ text: t('myday.snoozed'), undo: () => void write(x.id, { act_by: prev }) });
  };
  const empty = g.overdue.length + g.today.length + g.upcoming.length === 0;
  const Group = ({ label, list, late }: { label: string; list: TaskItem[]; late?: boolean }) => list.length === 0 ? null : (
    <View style={{ marginTop: 8 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1, color: late ? theme.status.overdue : theme.textMuted }}>{label.toUpperCase()} · {list.length}</Text>
      {list.slice(0, 4).map((x) => <Row key={x.id} theme={theme} x={x} late={late} onDone={() => complete(x)} onSnooze={() => snooze(x)} onOpen={() => onOpen(x.id)} />)}
    </View>
  );
  return (
    <View style={[s.card, { marginTop: 0, marginBottom: 10 }]} accessibilityLabel={t('myday.title')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Feather name="sun" size={18} color={theme.primary} />
        <Text style={[s.h1, { flex: 1, fontSize: 18 }]}>{t('myday.title')}</Text>
      </View>
      {empty ? (
        <View style={{ alignItems: 'center', paddingVertical: 16 }}>
          <Feather name="star" size={22} color={theme.primary} />
          <Text style={[s.text, { fontWeight: '600', marginTop: 6 }]}>{t('myday.empty')}</Text>
          <Text style={s.muted}>{t('myday.emptyHint')}</Text>
        </View>
      ) : (
        <>
          <Group label={t('myday.overdue')} list={g.overdue} late />
          <Group label={t('myday.today')} list={g.today} />
          <Group label={t('myday.upcoming')} list={g.upcoming} />
        </>
      )}
      {snack && (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: alpha(theme.primary, 0.12) }}>
          <Text style={[s.text, { flex: 1 }]} numberOfLines={2}>{snack.text}</Text>
          {snack.undo && <Pressable onPress={() => { snack.undo!(); setSnack(null); }} accessibilityRole="button" style={{ paddingHorizontal: 10, minHeight: 40, justifyContent: 'center' }}>
            <Text style={{ color: theme.primary, fontWeight: '700' }}>{t('myday.undo')}</Text></Pressable>}
        </View>
      )}
    </View>
  );
}

function Row({ theme, x, late, onDone, onSnooze, onOpen }: { theme: Theme; x: TaskItem; late?: boolean; onDone(): void; onSnooze(): void; onOpen(): void }) {
  const s = ui(theme);
  const still = useReduceMotion();
  const pop = useRef(new Animated.Value(1)).current;
  const [ticked, setTicked] = useState(false);
  const tick = () => {
    setTicked(true);
    if (still) { onDone(); return; }
    Animated.sequence([
      Animated.timing(pop, { toValue: 1.3, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(pop, { toValue: 1, friction: 4, useNativeDriver: true }),
    ]).start(() => onDone());
  };
  const d = x.actBy ?? x.statutoryDue;
  return (
    <View style={[s.row, { minHeight: 52 }]}>
      <Pressable onPress={tick} disabled={ticked} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('myday.complete', { title: x.title })}>
        <Animated.View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginRight: 12,
          borderColor: ticked ? theme.primary : theme.border, backgroundColor: ticked ? theme.primary : 'transparent', transform: [{ scale: pop }] }}>
          {ticked && <Feather name="check" size={15} color={theme.primaryText} />}
        </Animated.View>
      </Pressable>
      <Pressable style={{ flex: 1 }} onPress={onOpen} accessibilityRole="button">
        <Text style={[s.text, ticked && { textDecorationLine: 'line-through', opacity: 0.55 }]} numberOfLines={1}>{x.title}</Text>
        <Text style={[s.muted, late && { color: theme.status.overdue }]} numberOfLines={1}>
          {d ? formatDate(d) : ''}{x.priority === 'urgent' || x.priority === 'high' ? ` · ${t(`tasks.priority.${x.priority}` as never)}` : ''}
        </Text>
      </Pressable>
      <Pressable onPress={onSnooze} style={s.icon} accessibilityRole="button" accessibilityLabel={t('myday.snooze')}>
        <Feather name="moon" size={17} color={theme.textMuted} />
      </Pressable>
    </View>
  );
}

/** Floating + button that opens the one-line quick-add sheet. */
export function QuickAddFab({ theme }: { theme: Theme }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={t('quick.title')}
        style={{ position: 'absolute', right: 18, bottom: 78, width: 58, height: 58, borderRadius: 29, backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center',
          shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 8 }}>
        <Feather name="plus" size={26} color={theme.primaryText} />
      </Pressable>
      {open && <QuickAddSheet theme={theme} onClose={() => setOpen(false)} />}
    </>
  );
}

type Person = { id: string; name: string };

function QuickAddSheet({ theme, onClose }: { theme: Theme; onClose(): void }) {
  const s = ui(theme);
  const userId = useUserId();
  const me = useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')) }).data;
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')), retry: false, staleTime: 60_000 }).data;
  const people: Person[] = useMemo(() => (users ?? []).filter((u) => u.status !== 'disabled').map((u) => ({ id: u.id, name: u.name })), [users]);
  const clients = useClientItems();
  const [text, setText] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const meP = me ? { id: me.id, name: me.name } : userId ? { id: userId, name: '' } : null;
  const p = useMemo(() => parseQuickTask(text, { today: todayIST(), people, me: meP }), [text, people, meP?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const client = matchClient(clients, p.clientQuery);
  const missingClient = !!p.clientQuery && !client;

  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(slide, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(); }, [slide]);

  const save = async () => {
    if (!p.title || missingClient) return;
    const engine = getEngine();
    if (!engine) { setErr(t('common.error')); return; }
    setErr(null);
    await engine.write('task', Crypto.randomUUID(), {
      title: p.title, status: 'open', priority: p.priority, act_by: p.actBy, client_id: client?.id ?? null,
      assignee_id: p.assignee?.id ?? userId ?? null, checks: [],
    });
    void syncNow();
    setAdded((a) => [p.title, ...a].slice(0, 4));
    setText('');
  };

  const chip = (icon: 'calendar' | 'flag' | 'at-sign' | 'briefcase', label: string, bad?: boolean) => (
    <View key={icon + label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
      backgroundColor: bad ? alpha(theme.status.overdue, 0.15) : alpha(theme.primary, 0.14) }}>
      <Feather name={icon} size={12} color={bad ? theme.status.overdue : theme.primary} />
      <Text style={{ fontSize: 12, fontWeight: '600', color: bad ? theme.status.overdue : theme.text }}>{label}</Text>
    </View>
  );

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={onClose} accessibilityLabel={t('common.close')} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={{ backgroundColor: theme.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, paddingBottom: 28,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [300, 0] }) }] }}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: theme.border, marginBottom: 12 }} />
          <Text style={s.h1}>{t('quick.title')}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <TextInput style={[s.input, { flex: 1 }]} autoFocus value={text} onChangeText={setText} placeholder={t('quick.placeholder')}
              placeholderTextColor={theme.textMuted} returnKeyType="done" blurOnSubmit={false} onSubmitEditing={() => void save()} accessibilityLabel={t('quick.title')} />
            <Pressable onPress={() => void save()} disabled={!p.title || missingClient} accessibilityRole="button" accessibilityLabel={t('quick.add')}
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center', opacity: !p.title || missingClient ? 0.5 : 1 }}>
              <Feather name="arrow-up" size={22} color={theme.primaryText} />
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, minHeight: 26 }}>
            {p.clientQuery && chip('briefcase', client ? client.name : t('quick.clientNotFound', { q: p.clientQuery }), missingClient)}
            {p.actBy && chip('calendar', formatDate(p.actBy))}
            {p.priority !== 'normal' && chip('flag', t(`tasks.priority.${p.priority}` as never))}
            {p.assignee && chip('at-sign', p.assignee.name || t('quick.title'))}
          </View>
          {err && <Text style={[s.muted, { color: theme.status.overdue }]}>{err}</Text>}
          {added.length > 0 && (
            <View style={{ marginTop: 10 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1, color: theme.textMuted }}>{t('quick.justAdded').toUpperCase()}</Text>
              {added.map((a, i) => (
                <View key={a + i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <Feather name="check-circle" size={14} color={theme.primary} /><Text style={s.text} numberOfLines={1}>{a}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={[s.muted, { marginTop: 12 }]}>{t('quick.hint', { date: t('quick.datesEg') })}</Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
