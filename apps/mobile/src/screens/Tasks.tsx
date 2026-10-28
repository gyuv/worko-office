import { Feather } from '@expo/vector-icons';
import type { TaskStatus } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, SectionList, Switch, Text, TextInput, View } from 'react-native';
import {
  buildTodoPatch, changeError, complianceDueThisMonth, groupMyTasks, isOpen, isTodoOverdue, reasonKey, requiredPending, sortTodos,
  STATUS_KEY, statusOptions, toggleCheck, toTaskItem, toTodoItem, todoTogglePatch, workDate, type StatusFilter, type TaskItem,
} from '../logic/tasks';
import { todayIST } from '../logic/registers';
import { useSession } from '../session';
import { getEngine, syncNow, useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui, useTable } from '../ui';
import { useClientItems } from './Clients';
import { Header } from './Header';
import type { Nav } from './Stack';

export function useTasks(): TaskItem[] {
  const rows = useTable('task');
  return useMemo(() => rows.filter((r) => !r.deleted).map(toTaskItem), [rows]);
}
const useUserId = () => useSession((x) => x.tokens?.userId ?? '');
function useClientNames() {
  const clients = useClientItems();
  return useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
}

function statusColor(theme: Theme, task: TaskItem, today: string): string {
  if (task.status === 'done') return theme.status.done;
  if (isOpen(task) && (workDate(task) ?? '9999') < today) return theme.status.overdue;
  if (task.status === 'pending_client') return theme.status.waitingClient;
  if (task.status === 'in_progress' || task.status === 'review') return theme.status.inProgress;
  return theme.status.notStarted;
}

function TaskRow({ theme, task, client, onPress }: { theme: Theme; task: TaskItem; client?: string; onPress(): void }) {
  const s = ui(theme);
  const today = todayIST();
  return (
    <Pressable style={s.row} onPress={onPress} accessibilityRole="button">
      <View style={{ width: 4, alignSelf: 'stretch', backgroundColor: statusColor(theme, task, today), marginRight: 10, borderRadius: 2 }} />
      <View style={{ flex: 1 }}>
        <Text style={s.text} numberOfLines={2}>{task.title}</Text>
        <Text style={s.muted} numberOfLines={1}>{[client ?? t('m.task.firm'), t(STATUS_KEY[task.status]),
          task.actBy && `${t('m.task.actBy')} ${task.actBy}`].filter(Boolean).join(' · ')}</Text>
      </View>
      {requiredPending(task.checks) > 0 && <Text style={s.chip}>{requiredPending(task.checks)}</Text>}
    </Pressable>
  );
}

const FILTERS: StatusFilter[] = ['open', 'in_progress', 'pending_client', 'review', 'done', 'all'];
const filterLabel = (f: StatusFilter): MessageKey => (f === 'open' ? 'm.task.filter.open' : f === 'all' ? 'm.task.filter.all' : STATUS_KEY[f]);

export function TaskList({ theme, nav }: { theme: Theme; nav: Nav }) {
  const s = ui(theme);
  const tasks = useTasks();
  const userId = useUserId();
  const names = useClientNames();
  const [filter, setFilter] = useState<StatusFilter>('open');
  const groups = useMemo(() => groupMyTasks(tasks, userId, filter), [tasks, userId, filter]);
  const sections = ([['overdue', 'm.task.overdue'], ['today', 'm.task.today'], ['week', 'm.task.week'], ['later', 'm.task.later']] as const)
    .map(([k, label]) => ({ key: k, title: t(label), data: groups[k] })).filter((x) => x.data.length);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.task.title')} right={<View style={{ flexDirection: 'row' }}>
        <Pressable style={s.icon} onPress={() => nav.push({ name: 'todos' })} accessibilityRole="button" accessibilityLabel={t('m.todo.title')}>
          <Feather name="list" size={22} color={theme.primary} /></Pressable>
        <Pressable style={s.icon} onPress={() => nav.push({ name: 'compliance' })} accessibilityRole="button" accessibilityLabel={t('m.comp.title')}>
          <Feather name="calendar" size={22} color={theme.primary} /></Pressable>
      </View>} />
      <FlatList horizontal data={FILTERS} keyExtractor={(x) => x} showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 8 }}
        contentContainerStyle={{ gap: 6 }} renderItem={({ item }) => (
          <Pressable onPress={() => setFilter(item)} style={[s.chipBtn, filter === item && { backgroundColor: theme.primary, borderColor: theme.primary }]}
            accessibilityRole="radio" accessibilityState={{ checked: filter === item }}>
            <Text style={{ color: filter === item ? theme.primaryText : theme.text }}>{t(filterLabel(item))}</Text>
          </Pressable>)} />
      <SectionList sections={sections} keyExtractor={(x) => x.id} stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.task.empty')}</Text>}
        renderSectionHeader={({ section }) => <Text style={[s.h2, section.key === 'overdue' && { color: theme.status.overdue }]} accessibilityRole="header">
          {section.title} ({section.data.length})</Text>}
        renderItem={({ item }) => <TaskRow theme={theme} task={item} client={item.clientId ? names.get(item.clientId) : undefined}
          onPress={() => nav.push({ name: 'task', id: item.id })} />} />
    </View>
  );
}

/** Surfaces server rejections (the engine has already reverted the local change). */
function useRejections(onReject: (reason: string | undefined) => void) {
  const rejected = useSync((x) => x.rejected);
  const seen = useRef(rejected.length);
  useEffect(() => {
    if (rejected.length > seen.current) onReject(rejected[rejected.length - 1]?.reason);
    seen.current = rejected.length;
  }, [rejected, onReject]);
}

export function TaskDetail({ theme, id, onBack }: { theme: Theme; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const task = useTasks().find((x) => x.id === id);
  const names = useClientNames();
  const [issue, setIssue] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useRejections((reason) => setMsg(t('m.task.rejected', { reason: t(reasonKey(stripCode(reason))) })));
  if (!task) return <View><Header theme={theme} title={t('m.task.title')} onBack={onBack} /><Text style={s.muted}>{t('m.task.notFound')}</Text></View>;
  const closed = !!task.outcome;
  const pendingText = issue ?? task.pendingIssue ?? '';

  async function write(patch: Record<string, unknown>, local: Parameters<typeof changeError>[1]) {
    const why = changeError(task!, local);
    if (why) { setMsg(t(reasonKey(why))); return false; }
    const engine = getEngine();
    if (!engine) { setMsg(t('common.error')); return false; }
    setMsg(null);
    await engine.write('task', task!.id, patch);
    void syncNow();
    return true;
  }
  const setStatus = (status: TaskStatus) => void write(
    { status, ...(status === 'pending_client' ? { pending_issue: pendingText.trim() || null } : {}) },
    { status, pendingIssue: status === 'pending_client' ? pendingText.trim() || null : task.pendingIssue });
  const pickStatus = () => Alert.alert(t('m.task.changeStatus'), undefined, [
    ...statusOptions({ ...task, pendingIssue: pendingText.trim() || null }).map((o) => ({
      text: t(STATUS_KEY[o.status]), onPress: () => (o.blocked ? setMsg(t(reasonKey(o.blocked))) : setStatus(o.status)),
    })),
    { text: t('common.cancel'), style: 'cancel' as const },
  ]);

  return (
    <View>
      <Header theme={theme} title={task.title} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {closed && <Text style={s.alert}>{t('m.task.closed')}</Text>}
      <Text style={s.muted}>{task.clientId ? names.get(task.clientId) ?? '' : t('m.task.firm')}{task.periodLabel ? ` · ${task.periodLabel}` : ''}</Text>
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 12 }}>
        <View style={{ flex: 1 }}><Text style={s.label}>{t('m.task.actBy')}</Text><Text style={[s.text, { fontWeight: '600' }]}>{task.actBy ?? '—'}</Text></View>
        <View style={{ flex: 1 }}><Text style={s.label}>{t('m.task.statutoryDue')}</Text><Text style={s.text}>{task.statutoryDue ?? '—'}</Text></View>
      </View>
      <Text style={s.label}>{t('m.task.status')}</Text>
      <Pressable style={s.ghost} disabled={closed} onPress={pickStatus} accessibilityRole="button" accessibilityLabel={t('m.task.changeStatus')}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: statusColor(theme, task, todayIST()) }} />
        <Text style={s.ghostText}>{t(STATUS_KEY[task.status])}</Text>
        {!closed && <Feather name="chevron-down" size={16} color={theme.primary} />}
      </Pressable>
      <Text style={s.h2}>{t('m.task.checks')}</Text>
      {requiredPending(task.checks) > 0 && <Text style={s.muted}>{t('m.task.requiredLeft', { count: requiredPending(task.checks) })}</Text>}
      {!task.checks.length && <Text style={s.muted}>{t('m.task.noChecks')}</Text>}
      {task.checks.map((c) => (
        <View key={c.key} style={s.row}>
          <Text style={[s.text, { flex: 1 }]}>{c.label}{c.required ? ` · ${t('m.task.required')}` : ''}</Text>
          <Switch value={c.done} disabled={closed} accessibilityLabel={c.label}
            onValueChange={() => { const checks = toggleCheck(task.checks, c.key); void write({ checks }, { checks }); }} />
        </View>
      ))}
      <Text style={s.label}>{t('m.task.pendingIssue')}</Text>
      <TextInput style={[s.input, { minHeight: 72, textAlignVertical: 'top' }]} multiline editable={!closed} value={pendingText} onChangeText={setIssue}
        accessibilityLabel={t('m.task.pendingIssue')} />
      {!closed && issue !== null && issue !== (task.pendingIssue ?? '') && (
        <Pressable style={s.button} accessibilityRole="button" onPress={() => {
          const v = issue.trim() || null;
          void write({ pending_issue: v }, { pendingIssue: v }).then((ok) => { if (ok) setIssue(null); });
        }}><Text style={s.buttonText}>{t('m.task.savePending')}</Text></Pressable>
      )}
    </View>
  );
}
/** Server reasons can carry a suffix (`person_cannot_see_task:<id>`). */
const stripCode = (r?: string) => r?.split(':')[0];

export function Todos({ theme, onBack }: { theme: Theme; onBack?: () => void }) {
  const s = ui(theme);
  const rows = useTable('todo');
  const todos = useMemo(() => sortTodos(rows.filter((r) => !r.deleted).map(toTodoItem)), [rows]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [err, setErr] = useState<MessageKey | null>(null);
  async function add() {
    const r = buildTodoPatch(title, due);
    if (!r.ok) { setErr(r.error === 'title' ? 'm.todo.invalidTitle' : 'm.todo.invalidDue'); return; }
    const engine = getEngine(); if (!engine) { setErr('common.error'); return; }
    await engine.write('todo', Crypto.randomUUID(), r.patch);
    setTitle(''); setDue(''); setErr(null); void syncNow();
  }
  const write = async (id: string, patch: Record<string, unknown>, del = false) => { await getEngine()?.write('todo', id, patch, { delete: del }); void syncNow(); };
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.todo.title')} onBack={onBack} />
      {err && <Text accessibilityRole="alert" style={s.alert}>{t(err)}</Text>}
      <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder={t('m.todo.placeholder')} placeholderTextColor={theme.textMuted}
        accessibilityLabel={t('m.todo.placeholder')} onSubmitEditing={() => void add()} />
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <TextInput style={[s.input, { flex: 1 }]} value={due} onChangeText={setDue} placeholder={t('m.todo.due')} placeholderTextColor={theme.textMuted}
          keyboardType="numbers-and-punctuation" accessibilityLabel={t('m.todo.due')} />
        <Pressable style={[s.button, { marginTop: 0 }]} onPress={() => void add()} accessibilityRole="button"><Text style={s.buttonText}>{t('m.todo.add')}</Text></Pressable>
      </View>
      <FlatList data={todos} keyExtractor={(x) => x.id} keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.todo.empty')}</Text>}
        renderItem={({ item }) => (
          <View style={s.row}>
            <Pressable style={s.icon} onPress={() => void write(item.id, todoTogglePatch(item))} accessibilityRole="checkbox"
              accessibilityState={{ checked: item.done }} accessibilityLabel={t('m.todo.toggle', { title: item.title })}>
              <Feather name={item.done ? 'check-square' : 'square'} size={22} color={item.done ? theme.status.done : theme.textMuted} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={[s.text, item.done && { textDecorationLine: 'line-through', color: theme.textMuted }]}>{item.title}</Text>
              {item.dueAt && <Text style={[s.muted, isTodoOverdue(item) && { color: theme.status.overdue }]}>{t('m.todo.dueOn', { date: todayIST(new Date(item.dueAt)) })}</Text>}
            </View>
            <Pressable style={s.icon} onPress={() => void write(item.id, {}, true)} accessibilityRole="button" accessibilityLabel={t('m.todo.delete')}>
              <Feather name="trash-2" size={18} color={theme.textMuted} /></Pressable>
          </View>
        )} />
    </View>
  );
}

export function Compliance({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const tasks = useTasks();
  const types = useTable('service_type');
  const names = useClientNames();
  const typeName = useMemo(() => new Map(types.map((r) => [r.id, String(r.fields.name ?? '')])), [types]);
  const groups = useMemo(() => complianceDueThisMonth(tasks, (id) => typeName.get(id)), [tasks, typeName]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.comp.title')} onBack={onBack} />
      <SectionList sections={groups.map((g) => ({ ...g, data: g.tasks }))} keyExtractor={(x) => x.id} stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.comp.empty')}</Text>}
        renderSectionHeader={({ section }) => (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 12 }}>
            <Text style={[s.h2, { flex: 1, marginTop: 0 }]} accessibilityRole="header">{section.label}</Text>
            <Text style={s.muted}>{t('m.comp.counts', { open: section.open, total: section.tasks.length })}</Text>
          </View>)}
        renderItem={({ item }) => (
          <Pressable style={[s.row, { minHeight: 48 }]} onPress={() => nav.push({ name: 'task', id: item.id })} accessibilityRole="button">
            <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>{item.clientId ? names.get(item.clientId) ?? item.title : item.title}</Text>
            <Text style={[s.muted, { color: isOpen(item) ? theme.textMuted : theme.status.done }]}>{item.statutoryDue} · {t(STATUS_KEY[item.status])}</Text>
          </Pressable>)} />
    </View>
  );
}
