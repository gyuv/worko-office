import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReportDefinition } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import type { AiAvailability } from '../logic/automation';
import { hasGrant } from '../logic/billing';
import {
  aliasType, ASK_EXAMPLE, askBody, askVisible, cacheOwner, chartBars, chartValueKey, dashView, defaultSaveName, downloadToken, drillKey, formatValue, fyColumn, fyLabel, fyOptions,
  istStamp, istToday, kpiTile, readyExportId, reportError, routeForRefs, runBody, toDashboardData, widgetSource, withFy, type Col, type DashCache, type Group, type Row, type RunSource, type Widget,
} from '../logic/reports';
import { loadDashCache, openReportDownload, openReportExport, saveDashCache } from '../reportCache';
import { api, unwrap, useSession } from '../session';
import { useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui, useTable } from '../ui';
import { Header } from './Header';
import type { Nav } from './Stack';

/** Phase 11 on Android (D160–D170): REST-only; the default dashboard response is cached per user for offline KPIs. Staff mode only. */

type Obj = Record<string, unknown>;
type Err = { code?: string; status?: number; message?: string };
const errText = (e: unknown) => {
  const k = reportError(e as Err);
  return k ? t(`m.rep.err.${k}` as MessageKey) : t('m.rep.err.service', { reason: (e as Error).message });
};
const post = <T,>(path: string, body: Obj) => unwrap(api.POST(path as never, { body } as never)) as Promise<T>;
const get = <T,>(path: string) => unwrap(api.GET(path as never)) as Promise<T>;

function useGrants() { return useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')) }).data?.grants; }
export function useReportPerms() { const g = useGrants(); return { view: hasGrant(g, 'reports', 'view'), create: hasGrant(g, 'reports', 'create') }; }
export function useAskVisible(): boolean {
  const grants = useGrants();
  const online = useSync((x) => x.online);
  const av = useQuery({ queryKey: ['ai', 'availability'], enabled: online, retry: false, staleTime: 60_000, queryFn: async () => (await unwrap(api.GET('/ai/availability'))) as AiAvailability });
  return online && askVisible(av.isError ? null : av.data ?? null, grants);
}

// ---------- Home dashboard ----------
export function Dashboard({ theme, nav }: { theme: Theme; nav: Nav }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const tokens = useSession((x) => x.tokens);
  const owner = tokens ? cacheOwner(tokens.tenantId, tokens.userId) : '';
  const perms = useReportPerms();
  const ask = useAskVisible();
  const q = useQuery({ queryKey: ['rep', 'dash', owner], enabled: online && !!owner, retry: 1, queryFn: async () => toDashboardData(await get('/reports/dashboards/default/data')) });
  const [cached, setCached] = useState<DashCache | null>(null);
  useEffect(() => { let live = true; void loadDashCache(owner).then((c) => { if (live) setCached(c); }); return () => { live = false; }; }, [owner]);
  useEffect(() => { if (q.data && owner) void saveDashCache(owner, q.data); }, [q.data, owner]);
  const v = dashView(online && q.data ? q.data : undefined, cached, Date.now());
  const d = v.data;
  const open = (w: Widget) => { if (!d || !online) return; const src = widgetSource(d, w.id); if (src) nav.push({ name: 'report', source: src, title: w.title }); };
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />} contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {online && perms.view && <Pressable style={s.chipBtn} onPress={() => nav.push({ name: 'reportCatalogue' })} accessibilityRole="button"><Text style={s.ghostText}>{t('m.rep.catalogue')}</Text></Pressable>}
        {online && ask && <Pressable style={s.chipBtn} onPress={() => nav.push({ name: 'reportAsk' })} accessibilityRole="button"><Text style={s.ghostText}>{t('m.rep.ask')}</Text></Pressable>}
        <Pressable style={s.chipBtn} onPress={() => nav.push({ name: 'reportDownloads' })} accessibilityRole="button"><Text style={s.ghostText}>{t('m.rep.scheduled')}</Text></Pressable>
      </View>
      {v.fromCache && v.savedAt !== null && <View accessibilityRole="alert" style={[s.alert, { flexDirection: 'row', gap: 8, alignItems: 'center' }]}>
        <Feather name="archive" size={14} color={theme.text} />
        <Text style={{ color: theme.text, flex: 1 }}>{t(v.stale ? 'm.rep.savedCopyOld' : 'm.rep.savedCopy', { when: istStamp(v.savedAt) })}</Text>
      </View>}
      {!d && (q.isLoading ? <ActivityIndicator /> : <Text style={s.alert}>{!online ? t('m.rep.noCache') : q.error ? t('m.rep.loadFailed', { reason: errText(q.error) }) : t('m.rep.noDashboard')}</Text>)}
      {d && !d.widgets.length && <Text style={s.muted}>{t('m.rep.noDashboard')}</Text>}
      {d && <>
        {!!d.dashboard.name && <Text style={s.h2}>{d.dashboard.name}</Text>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {d.widgets.filter((w) => w.kind === 'kpi').map((w) => <KpiCard key={w.id} theme={theme} w={w} onPress={online ? () => open(w) : undefined} />)}
        </View>
        {d.widgets.filter((w) => w.kind !== 'kpi').map((w) => (
          <View key={w.id} style={{ marginTop: 16 }}>
            <Pressable onPress={online ? () => open(w) : undefined} accessibilityRole="button" accessibilityHint={online ? t('m.rep.open') : undefined} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
              <Text style={[s.h2, { flex: 1, marginTop: 0, marginBottom: 0 }]}>{w.title}</Text>
              {online && <Feather name="chevron-right" size={18} color={theme.textMuted} />}
            </Pressable>
            {w.error ? <Text style={s.muted}>{t('m.rep.widgetErr', { reason: errText({ code: w.error }) })}</Text>
              : w.kind === 'chart' ? <WidgetChart theme={theme} w={w as Extract<Widget, { kind: 'chart'; error?: undefined }>} />
              : <WidgetTable theme={theme} w={w as Extract<Widget, { kind: 'table'; error?: undefined }>} nav={online ? nav : undefined} />}
          </View>
        ))}
      </>}
    </ScrollView>
  );
}

function KpiCard({ theme, w, onPress }: { theme: Theme; w: Widget; onPress?: () => void }) {
  const s = ui(theme);
  const k = kpiTile(w);
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={`${k.title}: ${k.text}`}
      style={{ flexBasis: '47%', flexGrow: 1, minHeight: 84, padding: 12, borderRadius: 6, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border }}>
      <Text style={s.muted} numberOfLines={2}>{k.title}</Text>
      <Text style={{ fontSize: 22, fontWeight: '600', color: theme.text, marginTop: 4, fontVariant: ['tabular-nums'] }} numberOfLines={1} adjustsFontSizeToFit>{k.text}</Text>
      {k.note === 'hidden' && <Text style={s.muted}>{t('m.rep.hiddenValue')}</Text>}
      {k.note === 'error' && <Text style={s.muted}>{t('m.rep.widgetErr', { reason: errText({ code: k.error ?? undefined }) })}</Text>}
    </Pressable>
  );
}

function WidgetChart({ theme, w }: { theme: Theme; w: Extract<Widget, { kind: 'chart'; error?: undefined }> }) {
  const key = chartValueKey(w.groups);
  if (!key) return <Text style={ui(theme).muted}>{t('m.rep.noRows')}</Text>;
  return <Bars theme={theme} groups={w.groups} valueKey={key} type={aliasType(key, [])} />;
}

/** Single-series horizontal bars (one hue = magnitude). Labels/values in text ink; 4px rounded data end; 2px gaps. Tap = drill-down. */
function Bars({ theme, groups, valueKey, type, onBar }: { theme: Theme; groups: Group[]; valueKey: string; type: string; onBar?: (g: Group) => void }) {
  const s = ui(theme);
  const bars = useMemo(() => chartBars(groups, valueKey, type, 8, t('m.rep.other')), [groups, valueKey, type]);
  return (
    <View accessibilityRole="summary">
      {onBar && <Text style={[s.muted, { marginBottom: 4 }]}>{t('m.rep.chartHint')}</Text>}
      {bars.map((b, i) => {
        const g = b.key ? groups.find((x) => x.key === b.key) : undefined;
        return (
          <Pressable key={i} disabled={!onBar || !g} onPress={() => g && onBar?.(g)} accessibilityRole={onBar && g ? 'button' : 'text'} accessibilityLabel={`${b.label}: ${b.text}`}
            style={{ minHeight: 44, justifyContent: 'center', marginBottom: 2 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={[s.muted, { flex: 1, color: theme.text }]} numberOfLines={1}>{b.label}</Text>
              <Text style={[s.muted, { fontVariant: ['tabular-nums'] }]}>{b.text}</Text>
            </View>
            <View style={{ height: 8, marginTop: 2, backgroundColor: theme.surfaceAlt, borderRadius: 4 }}>
              <View style={{ height: 8, width: `${Math.max(b.frac * 100, b.value > 0 ? 1 : 0)}%`, backgroundColor: theme.primary, borderTopRightRadius: 4, borderBottomRightRadius: 4 }} />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function WidgetTable({ theme, w, nav }: { theme: Theme; w: Extract<Widget, { kind: 'table'; error?: undefined }>; nav?: Nav }) {
  const s = ui(theme);
  return (
    <View>
      {w.rows.slice(0, 5).map((r, i) => <RowItem key={i} theme={theme} row={r} columns={w.columns} nav={nav} />)}
      {!w.rows.length && <Text style={s.muted}>{t('m.rep.noRows')}</Text>}
      {w.rowCount > w.rows.length && <Text style={s.muted}>{t('m.rep.rowsOf', { shown: Math.min(5, w.rows.length), total: w.rowCount })}</Text>}
      {!!w.hiddenColumns.length && <Text style={s.muted}>{t('m.rep.hiddenCols', { cols: w.hiddenColumns.join(', ') })}</Text>}
    </View>
  );
}

function RowItem({ theme, row, columns, nav }: { theme: Theme; row: Row; columns: Col[]; nav?: Nav }) {
  const s = ui(theme);
  const route = routeForRefs(row.refs);
  const [first, ...rest] = columns;
  return (
    <Pressable style={s.row} disabled={!nav || !route} onPress={() => route && nav?.push(route)} accessibilityRole={nav && route ? 'button' : 'text'} accessibilityHint={nav && route ? t('m.rep.tapRow') : undefined}>
      <View style={{ flex: 1 }}>
        {first && <Text style={s.text} numberOfLines={1}>{formatValue(row.values[first.key], first.type)}</Text>}
        <Text style={s.muted} numberOfLines={2}>{rest.slice(0, 4).map((c) => `${c.label}: ${formatValue(row.values[c.key], c.type)}`).join(' · ')}</Text>
      </View>
      {nav && route && <Feather name="chevron-right" size={18} color={theme.textMuted} />}
    </Pressable>
  );
}

// ---------- Report view (run + FY picker + groups + drill-down + rows) ----------
type RunResult = {
  name?: string; definition: ReportDefinition; explanation: string; columns: Col[]; hiddenColumns: string[]; asOf: string; rows: Row[]; rowCount: number; page: number; pageSize: number;
  totals: Record<string, unknown>; groups: Group[]; groupsTruncated: boolean;
};

export function ReportResultView({ theme, nav, r, onDrill }: { theme: Theme; nav: Nav; r: RunResult; onDrill?: (g: Group) => void }) {
  const s = ui(theme);
  const totals = Object.entries(r.totals ?? {});
  const valueKey = chartValueKey(r.groups);
  return (
    <View>
      <Text style={s.muted}>{r.explanation}</Text>
      <Text style={s.muted}>{t('m.rep.asOf', { date: formatValue(r.asOf, 'date') })}</Text>
      {!!r.hiddenColumns.length && <Text style={s.alert}>{t('m.rep.hiddenCols', { cols: r.hiddenColumns.join(', ') })}</Text>}
      {!!totals.length && <><Text style={s.h2}>{t('m.rep.totals')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{totals.map(([k, v]) => (
          <View key={k}><Text style={s.muted}>{k.replace(/_/g, ' ')}</Text><Text style={[s.text, { fontWeight: '600', fontVariant: ['tabular-nums'] }]}>{formatValue(v, aliasType(k, r.columns))}</Text></View>))}</View></>}
      {!!r.groups.length && valueKey && <>
        <Text style={s.h2}>{t('m.rep.groups')}</Text>
        <Bars theme={theme} groups={r.groups} valueKey={valueKey} type={aliasType(valueKey, r.columns)} onBar={onDrill} />
        <Text style={[s.label]}>{t('m.rep.tableView')}</Text>
        {r.groups.map((g, i) => (
          <Pressable key={i} style={s.row} disabled={!onDrill} onPress={() => onDrill?.(g)} accessibilityRole="button">
            <Text style={[s.text, { flex: 1 }]}>{g.label}</Text>
            <Text style={[s.muted, { fontVariant: ['tabular-nums'] }]}>{Object.entries(g.values).map(([k, v]) => formatValue(v, aliasType(k, r.columns))).join(' · ')}</Text>
            {onDrill && <Feather name="chevron-right" size={18} color={theme.textMuted} />}
          </Pressable>
        ))}
        {r.groupsTruncated && <Text style={s.muted}>{t('m.rep.groupsTruncated')}</Text>}
      </>}
      {!r.groups.length && <>
        <Text style={s.h2}>{t('m.rep.rows')}</Text>
        {r.rows.map((row, i) => <RowItem key={i} theme={theme} row={row} columns={r.columns} nav={nav} />)}
        {!r.rows.length && <Text style={s.muted}>{t('m.rep.noRows')}</Text>}
        {r.rowCount > r.rows.length && <Text style={s.muted}>{t('m.rep.rowsOf', { shown: r.rows.length, total: r.rowCount })}</Text>}
      </>}
    </View>
  );
}

export function ReportView({ theme, nav, source, title, drill, onBack }: { theme: Theme; nav: Nav; source: RunSource; title: string; drill?: Obj; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const [src, setSrc] = useState<RunSource>(source);
  const [pageSize, setPageSize] = useState(50);
  const q = useQuery({ queryKey: ['rep', 'run', src, drill ?? null, pageSize], enabled: online, retry: false, queryFn: () => post<RunResult>('/reports/run', runBody(src, { drill, pageSize })) });
  const def = q.data?.definition;
  const fyCol = def && !drill ? fyColumn(def) : null;
  const currentFyValue = def?.filters.find((f) => f.column === fyCol && f.op === 'fy')?.value as string | undefined;
  const today = istToday(Date.now());
  if (!online) return <View><Header theme={theme} title={title} onBack={onBack} /><Text style={s.alert}>{t('m.rep.offline')}</Text></View>;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}>
      <Header theme={theme} title={drill ? t('m.rep.drill', { group: Object.values(drill).map((v) => (v === null ? '(none)' : String(v))).join(' / ') }) : title} onBack={onBack} />
      {fyCol && def && <><Text style={s.label}>{t('m.rep.fy')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {fyOptions(today, 4).map((fy) => (
            <Pressable key={fy} style={[s.chipBtn, currentFyValue === fy && { backgroundColor: theme.primary, borderColor: theme.primary }]} onPress={() => setSrc({ definition: withFy(def, fy), params: src.params })}
              accessibilityRole="button" accessibilityState={{ selected: currentFyValue === fy }}>
              <Text style={{ color: currentFyValue === fy ? theme.primaryText : theme.primary, fontWeight: '600' }}>{fyLabel(fy)}</Text>
            </Pressable>))}
        </ScrollView></>}
      {q.isLoading && <ActivityIndicator style={{ marginTop: 16 }} />}
      {q.error && <Text style={s.alert}>{errText(q.error)}</Text>}
      {q.data && <ReportResultView theme={theme} nav={nav} r={q.data}
        onDrill={drill ? undefined : (g) => nav.push({ name: 'report', source: src, title, drill: drillKey(g) })} />}
      {q.data && !q.data.groups.length && q.data.rowCount > q.data.rows.length && pageSize < 500 &&
        <Pressable style={s.ghost} onPress={() => setPageSize((n) => Math.min(500, n * 2))} accessibilityRole="button"><Text style={s.ghostText}>{t('m.rep.more')}</Text></Pressable>}
    </ScrollView>
  );
}

// ---------- Catalogue ----------
type CatItem = { key: string; name: string; description: string; explanation: string };
export function ReportCatalogue({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const q = useQuery({ queryKey: ['rep', 'catalogue'], enabled: online, queryFn: async () => { const r = await get<unknown>('/reports/catalogue'); return (Array.isArray(r) ? r : ((r as Obj).items ?? [])) as CatItem[]; } });
  const saved = useQuery({ queryKey: ['rep', 'saved'], enabled: online, queryFn: async () => ((await get<Obj>('/reports/saved')).items ?? []) as Array<{ id: string; name: string; description?: string | null }> });
  if (!online) return <View><Header theme={theme} title={t('m.rep.catalogue')} onBack={onBack} /><Text style={s.alert}>{t('m.rep.offline')}</Text></View>;
  const rows = [...(saved.data ?? []).map((x) => ({ id: `s:${x.id}`, name: x.name, sub: x.description ?? '', source: { reportId: x.id } as RunSource })),
    ...(q.data ?? []).map((x) => ({ id: `c:${x.key}`, name: x.name, sub: x.description, source: { catalogueKey: x.key } as RunSource }))];
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.rep.catalogue')} onBack={onBack} />
      {q.error && <Text style={s.alert}>{errText(q.error)}</Text>}
      <FlatList data={rows} keyExtractor={(x) => x.id} refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => { void q.refetch(); void saved.refetch(); }} />}
        ListEmptyComponent={<Text style={s.muted}>{q.isLoading ? t('common.loading') : t('m.rep.noReports')}</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => nav.push({ name: 'report', source: item.source, title: item.name })} accessibilityRole="button">
            <View style={{ flex: 1 }}><Text style={s.text}>{item.name}</Text>{!!item.sub && <Text style={s.muted} numberOfLines={2}>{item.sub}</Text>}</View>
            <Feather name="chevron-right" size={18} color={theme.textMuted} />
          </Pressable>)} />
    </View>
  );
}

// ---------- Scheduled report links ----------
export function ReportDownloads({ theme, token, exportId, onBack }: { theme: Theme; token?: string; exportId?: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const [link, setLink] = useState(token ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const dl = useMutation({ mutationFn: (tok: string) => openReportDownload(tok), onSuccess: () => setMsg(null), onError: (e) => setMsg(errText(e)) });
  const notes = useTable('notification').filter((r) => !r.deleted && r.fields.category === 'report.ready')
    .sort((a, b) => String(b.fields.fire_at ?? '').localeCompare(String(a.fields.fire_at ?? '')));
  const go = (raw: string) => { const tok = downloadToken(raw); if (!tok) { setMsg(t('m.rep.dl.badLink')); return; } setMsg(null); dl.mutate(tok); };
  const byId = useMutation({ mutationFn: (id: string) => openReportExport(id), onSuccess: () => setMsg(null), onError: (e) => setMsg(errText(e)) });
  const busy = dl.isPending || byId.isPending;
  const { mutate } = dl; const mutateId = byId.mutate;
  useEffect(() => { const tok = downloadToken(token); if (tok && online) mutate(tok); }, [token, online, mutate]);
  useEffect(() => { if (exportId && online) mutateId(exportId); }, [exportId, online, mutateId]);
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      <Header theme={theme} title={t('m.rep.dl.title')} onBack={onBack} />
      <Text style={s.muted}>{t('m.rep.dl.help')}</Text>
      {!online && <Text style={s.alert}>{t('m.rep.offline')}</Text>}
      <Text style={s.label}>{t('m.rep.dl.paste')}</Text>
      <TextInput style={s.input} value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('m.rep.dl.paste')} placeholder="https://…/reports/downloads/…" placeholderTextColor={theme.textMuted} />
      <Pressable style={[s.button, (!online || busy) && { opacity: 0.5 }]} disabled={!online || busy} onPress={() => go(link)} accessibilityRole="button">
        <Text style={s.buttonText}>{busy ? t('m.rep.dl.downloading') : t('m.rep.dl.open')}</Text>
      </Pressable>
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <Text style={s.muted}>{t('m.rep.dl.currentAccess')}</Text>
      <Text style={s.h2}>{t('m.rep.dl.recent')}</Text>
      {!notes.length && <Text style={s.muted}>{t('m.rep.dl.none')}</Text>}
      {notes.map((n) => { const id = readyExportId(n.fields); return (
        <Pressable key={n.id} style={s.row} disabled={!id || !online || busy} onPress={() => id && byId.mutate(id)} accessibilityRole="button" accessibilityHint={t('m.rep.dl.tapToOpen')}>
          <View style={{ flex: 1 }}>
            <Text style={s.text}>{String(n.fields.title ?? '')}</Text>
            {!!n.fields.body && <Text style={s.muted}>{String(n.fields.body)}</Text>}
          </View>
          {id && <Feather name="download" size={18} color={theme.primary} />}
        </Pressable>); })}
    </ScrollView>
  );
}

// ---------- Ask (NL query) ----------
type AskAnswer = { id: string; definition: ReportDefinition; explanation: string; sources: Array<{ type: string; key: string; label: string; columns: string[] }>; mock: boolean; result: RunResult | null };
export function ReportAsk({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const visible = useAskVisible();
  const perms = useReportPerms();
  const [question, setQuestion] = useState('');
  const [name, setName] = useState('');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const ask = useMutation({ mutationFn: (qq: string) => post<AskAnswer>('/reports/ask', askBody(qq)), onSuccess: (_a, qq) => { setName(defaultSaveName(qq)); setSavedMsg(null); } });
  const save = useMutation({ mutationFn: (a: { id: string; name: string }) => post<Obj>(`/reports/ask/${a.id}/save`, { name: a.name.trim() || 'AI report' }), onSuccess: () => setSavedMsg(t('m.rep.ask.saved')), onError: (e) => setSavedMsg(errText(e)) });
  if (!visible) return <View><Header theme={theme} title={t('m.rep.ask.title')} onBack={onBack} /><Text style={s.alert}>{t('m.rep.ask.unavailable')}</Text></View>;
  const a = ask.data;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      <Header theme={theme} title={t('m.rep.ask.title')} onBack={onBack} />
      <TextInput style={[s.input, { minHeight: 72, textAlignVertical: 'top', paddingTop: 10 }]} multiline maxLength={500} value={question} onChangeText={setQuestion}
        placeholder={t('m.rep.ask.placeholder', { example: ASK_EXAMPLE })} placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.rep.ask.title')} />
      <Pressable style={[s.button, (!question.trim() || ask.isPending) && { opacity: 0.5 }]} disabled={!question.trim() || ask.isPending} onPress={() => ask.mutate(question)} accessibilityRole="button">
        <Text style={s.buttonText}>{ask.isPending ? t('m.rep.running') : t('m.rep.ask.send')}</Text>
      </Pressable>
      {ask.error && <Text accessibilityRole="alert" style={s.alert}>{errText(ask.error)}</Text>}
      {a && <View style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', padding: 8, borderRadius: 6, borderWidth: 1, borderColor: theme.status.dueSoon }}>
          <Feather name="alert-triangle" size={14} color={theme.status.dueSoon} />
          <Text style={{ color: theme.text, flex: 1, fontWeight: '600' }}>{t('m.rep.ask.badge')}</Text>
        </View>
        {a.mock && <Text style={s.muted}>{t('m.rep.ask.mock')}</Text>}
        <Text style={s.h2}>{t('m.rep.ask.interpretation')}</Text>
        <Text style={s.text}>{a.explanation}</Text>
        <Text style={s.h2}>{t('m.rep.ask.sources')}</Text>
        {a.sources.map((src, i) => <Text key={i} style={s.muted}>{src.label} — {src.columns.join(', ')}</Text>)}
        {perms.create && <>
          <Text style={s.label}>{t('m.rep.ask.saveName')}</Text>
          <TextInput style={s.input} value={name} onChangeText={setName} maxLength={120} accessibilityLabel={t('m.rep.ask.saveName')} />
          <Pressable style={[s.ghost, { marginTop: 8 }, save.isPending && { opacity: 0.5 }]} disabled={save.isPending || save.isSuccess} onPress={() => save.mutate({ id: a.id, name })} accessibilityRole="button">
            <Feather name="bookmark" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.rep.ask.save')}</Text>
          </Pressable></>}
        {savedMsg && <Text style={s.alert}>{savedMsg}</Text>}
        {a.result && <View style={{ marginTop: 8 }}>
          <ReportResultView theme={theme} nav={nav} r={a.result} onDrill={(g) => nav.push({ name: 'report', source: { definition: a.definition }, title: question.trim(), drill: drillKey(g) })} />
        </View>}
      </View>}
    </ScrollView>
  );
}
