import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, type AiFeature } from '@worko/domain';
import { relativeTime, type MessageKey } from '@worko/i18n';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import {
  agentStates, aiErrorCode, aiFeatureVisible, allowedActions, approveBody, dryRunSummary, groupRunActions, rejectBody, runRetryable, scheduleText,
  toRuleItem, toRunAction, toSuggestion, type AiAvailability, type RuleItem, type Suggestion,
} from '../logic/automation';
import { api, unwrap } from '../session';
import { useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui } from '../ui';
import { Header } from './Header';
import type { Nav } from './Stack';

/** Phase 10 on Android (D141–D152): online REST only; suggestions are never synced. Staff mode only. */

type Obj = Record<string, unknown>;
const items = (r: unknown) => (((r as Obj | undefined)?.items ?? []) as Obj[]);
const errText = (e: unknown) => {
  const code = aiErrorCode((e as { code?: string }).code);
  return code ? t(`m.ai.err.${code}` as MessageKey) : t('m.ai.err.service', { reason: (e as Error).message });
};

// ---------- AI visibility hook (also used by the client timeline) ----------
export function useAiVisible(feature: AiFeature): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')) }).data;
  const av = useQuery({ queryKey: ['ai', 'availability'], retry: false, staleTime: 60_000,
    queryFn: async () => (await unwrap(api.GET('/ai/availability'))) as AiAvailability });
  return aiFeatureVisible(av.isError ? null : av.data ?? null, feature, me?.grants);
}

// ---------- Automation hub ----------
export function AutomationHub({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const qcl = useQueryClient();
  const agents = useQuery({ queryKey: ['auto', 'agents'], enabled: online, queryFn: async () => items(await unwrap(api.GET('/automation/agents'))) });
  const rules = useQuery({ queryKey: ['auto', 'rules'], enabled: online, queryFn: async () => items(await unwrap(api.GET('/automation/rules'))).map(toRuleItem) });
  const runs = useQuery({ queryKey: ['auto', 'runs'], enabled: online, queryFn: async () => items(await unwrap(api.GET('/automation/runs', { params: { query: { limit: 20 } } }))) });
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; data: Obj } | null>(null);
  const refresh = () => void qcl.invalidateQueries({ queryKey: ['auto'] });
  const onErr = (e: unknown) => setMsg(t('m.auto.failed', { reason: (e as Error).message }));
  const previewM = useMutation({
    mutationFn: async (key: string) => ({ key, data: (await unwrap(api.POST('/automation/agents/{key}/preview', { params: { path: { key } }, body: {} }))) as Obj }),
    onSuccess: (p) => { setMsg(null); setPreview(p); }, onError: onErr,
  });
  const enableAgent = useMutation({
    mutationFn: (key: string) => unwrap(api.POST('/automation/agents/{key}/enable', { params: { path: { key } }, body: {} })),
    onSuccess: () => { setPreview(null); setMsg(t('m.auto.enabled')); refresh(); }, onError: onErr,
  });
  const toggle = useMutation({
    mutationFn: (r: RuleItem) => unwrap(r.enabled ? api.POST('/automation/rules/{id}/disable', { params: { path: { id: r.id } } }) : api.POST('/automation/rules/{id}/enable', { params: { path: { id: r.id } } })),
    onSuccess: (_d, r) => { setMsg(t(r.enabled ? 'm.auto.disabled' : 'm.auto.enabled')); refresh(); }, onError: onErr,
  });
  const resume = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/automation/rules/{id}/resume', { params: { path: { id } } })),
    onSuccess: () => { setMsg(t('m.auto.resumed')); refresh(); }, onError: onErr,
  });
  const agentList = useMemo(() => agentStates((agents.data ?? []).map((a) => ({ key: String(a.key), name: String(a.name), description: String(a.description ?? '') })), rules.data ?? []), [agents.data, rules.data]);
  if (!online) return <View><Header theme={theme} title={t('m.auto.title')} onBack={onBack} /><Text style={s.alert}>{t('m.auto.offline')}</Text></View>;
  const loadErr = agents.error ?? rules.error ?? runs.error;
  const busy = previewM.isPending || enableAgent.isPending || toggle.isPending || resume.isPending;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={rules.isFetching} onRefresh={refresh} />}>
      <Header theme={theme} title={t('m.auto.title')} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {loadErr && <Text style={s.alert}>{t('m.auto.loadFailed', { reason: (loadErr as Error).message })}</Text>}
      {(agents.isLoading || rules.isLoading) && <ActivityIndicator />}

      <Text style={s.h2}>{t('m.auto.agents')}</Text>
      {!agents.isLoading && !agentList.length && <Text style={s.muted}>{t('m.auto.noAgents')}</Text>}
      {agentList.map((a) => (
        <View key={a.key} style={[s.row, { flexDirection: 'column', alignItems: 'stretch' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[s.text, { flex: 1, fontWeight: '600' }]}>{a.name}</Text>
            <Text style={s.chip}>{a.rule?.paused ? t('m.auto.paused') : t(a.on ? 'm.auto.on' : 'm.auto.off')}</Text>
          </View>
          {!!a.description && <Text style={s.muted}>{a.description}</Text>}
          {a.rule ? (
            <Pressable style={[s.ghost, { marginTop: 6, alignSelf: 'flex-start' }]} disabled={busy} onPress={() => toggle.mutate(a.rule!)} accessibilityRole="button">
              <Text style={s.ghostText}>{t(a.rule.enabled ? 'm.auto.disable' : 'm.auto.enable')}</Text></Pressable>
          ) : preview?.key === a.key ? (
            <DryRunCard theme={theme} data={preview.data} onConfirm={() => enableAgent.mutate(a.key)} onCancel={() => setPreview(null)} busy={busy} />
          ) : (
            <Pressable style={[s.ghost, { marginTop: 6, alignSelf: 'flex-start' }]} disabled={busy} onPress={() => previewM.mutate(a.key)} accessibilityRole="button">
              <Feather name="eye" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.auto.preview')}</Text></Pressable>
          )}
        </View>
      ))}

      <Text style={s.h2}>{t('m.auto.rules')}</Text>
      {!rules.isLoading && !(rules.data ?? []).length && <Text style={s.muted}>{t('m.auto.noRules')}</Text>}
      {(rules.data ?? []).map((r) => <RuleRow key={r.id} theme={theme} rule={r} busy={busy} onToggle={() => toggle.mutate(r)} onResume={() => resume.mutate(r.id)} />)}

      <Text style={s.h2}>{t('m.auto.runs')}</Text>
      {!runs.isLoading && !(runs.data ?? []).length && <Text style={s.muted}>{t('m.auto.noRuns')}</Text>}
      {(runs.data ?? []).map((r) => (
        <Pressable key={String(r.id)} style={s.row} onPress={() => nav.push({ name: 'autoRun', id: String(r.id) })} accessibilityRole="button">
          <View style={{ flex: 1 }}>
            <Text style={s.text} numberOfLines={1}>{String(r.ruleName ?? '')}</Text>
            <Text style={s.muted}>{[t(`m.auto.status.${String(r.status)}` as MessageKey), `${Number(r.actionsDone ?? 0)}/${Number(r.actionsTotal ?? 0)}`, relativeTime(String(r.startedAt ?? ''))].join(' · ')}</Text>
          </View>
          <Feather name="chevron-right" size={18} color={theme.textMuted} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function DryRunCard({ theme, data, onConfirm, onCancel, busy }: { theme: Theme; data: Obj; onConfirm(): void; onCancel(): void; busy: boolean }) {
  const s = ui(theme);
  const d = dryRunSummary(data);
  return (
    <View style={{ marginTop: 8, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}>
      <Text style={[s.text, { fontWeight: '600' }]}>{t('m.auto.previewTitle')}</Text>
      <Text style={s.text}>{[t('m.auto.dry.evaluated', { count: d.evaluated }), t('m.auto.dry.matched', { count: d.matched }), t('m.auto.dry.skipped', { count: d.skipped })].join(' · ')}</Text>
      <Text style={s.text}>{t('m.auto.dry.actions', { count: d.actions })}{d.refused ? ` · ${t('m.auto.dry.refused', { count: d.refused })}` : ''}</Text>
      {d.refusals.map(([reason, count]) => <Text key={reason} style={s.muted}>{t('m.auto.dry.refusal', { reason, count })}</Text>)}
      <Text style={s.muted}>{t('m.auto.dry.cost', { amount: formatINR(d.estimatedCostPaise) })}</Text>
      <Text style={s.muted}>{t('m.auto.previewNote')}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable style={[s.button, { flex: 1 }, busy && { opacity: 0.5 }]} disabled={busy} onPress={onConfirm} accessibilityRole="button"><Text style={s.buttonText}>{t('m.auto.enable')}</Text></Pressable>
        <Pressable style={[s.ghost, { marginTop: 12 }]} onPress={onCancel} accessibilityRole="button"><Text style={s.ghostText}>{t('m.auto.cancel')}</Text></Pressable>
      </View>
    </View>
  );
}

function RuleRow({ theme, rule, busy, onToggle, onResume }: { theme: Theme; rule: RuleItem; busy: boolean; onToggle(): void; onResume(): void }) {
  const s = ui(theme);
  const sch = rule.schedule ? scheduleText(rule.schedule, new Date()) : null;
  return (
    <View style={[s.row, { flexDirection: 'column', alignItems: 'stretch' }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={[s.text, { flex: 1, fontWeight: '600' }]} numberOfLines={2}>{rule.name}</Text>
        {rule.paused && <Text style={[s.chip, { color: theme.status.overdue }]}>{t('m.auto.paused')}</Text>}
        <Text style={s.chip}>{t(rule.enabled ? 'm.auto.on' : 'm.auto.off')}</Text>
      </View>
      {sch ? <>
        <Text style={s.muted}>{t(sch.key, { ...sch.params, weekday: sch.weekday ? t(`m.auto.wd.${sch.weekday}` as MessageKey) : '' })}</Text>
        {rule.enabled && !rule.paused && <Text style={s.muted}>{t('m.auto.sched.next', { next: sch.params.next })}</Text>}
      </> : <Text style={s.muted}>{t('m.auto.trigger', { event: rule.trigger })}</Text>}
      {rule.paused && <Text style={[s.muted, { color: theme.status.overdue }]}>{t('m.auto.pausedReason', { reason: rule.pausedReason ?? '' })}</Text>}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
        {rule.paused && <Pressable style={s.ghost} disabled={busy} onPress={onResume} accessibilityRole="button"><Feather name="play" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.auto.resume')}</Text></Pressable>}
        <Pressable style={s.ghost} disabled={busy} onPress={onToggle} accessibilityRole="button"><Text style={s.ghostText}>{t(rule.enabled ? 'm.auto.disable' : 'm.auto.enable')}</Text></Pressable>
      </View>
    </View>
  );
}

export function RunDetail({ theme, id, onBack }: { theme: Theme; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const qcl = useQueryClient();
  const q = useQuery({ queryKey: ['auto', 'run', id], queryFn: async () => (await unwrap(api.GET('/automation/runs/{id}', { params: { path: { id } } }))) as Obj });
  const [msg, setMsg] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: async () => (await unwrap(api.POST('/automation/runs/{id}/retry', { params: { path: { id } } }))) as Obj,
    onSuccess: (r) => { setMsg(t('m.auto.retried', { count: Number(r.retried ?? 0) })); void qcl.invalidateQueries({ queryKey: ['auto'] }); },
    onError: (e) => setMsg(t('m.auto.failed', { reason: (e as Error).message })),
  });
  const r = q.data;
  const g = useMemo(() => groupRunActions(((r?.actions ?? []) as Obj[]).map(toRunAction)), [r]);
  return (
    <View>
      <Header theme={theme} title={r ? String(r.ruleName ?? t('m.auto.run')) : t('m.auto.run')} onBack={onBack} />
      {q.isLoading && <ActivityIndicator />}
      {q.error && <Text style={s.alert}>{t('m.auto.loadFailed', { reason: (q.error as Error).message })}</Text>}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {r && <>
        <Text style={s.text}>{[t(`m.auto.status.${String(r.status)}` as MessageKey), r.eventType ? String(r.eventType) : '', relativeTime(String(r.startedAt ?? ''))].filter(Boolean).join(' · ')}</Text>
        {!!r.skipReason && <Text style={s.muted}>{t('m.auto.skipReason', { reason: String(r.skipReason) })}</Text>}
        {!!r.error && <Text style={[s.muted, { color: theme.status.overdue }]}>{String(r.error)}</Text>}
        <Text style={s.muted}>{t('m.auto.cost', { amount: formatINR(g.costPaise) })}</Text>
        {g.groups.map((grp) => (
          <View key={grp.status}>
            <Text style={s.h2}>{t(`m.auto.act.${grp.status}` as MessageKey)} · {grp.items.length}</Text>
            {grp.items.map((a) => (
              <View key={a.idx} style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.text}>{`${a.idx + 1}. ${a.type}`}</Text>
                  {(a.code || a.error) && <Text style={s.muted}>{[a.code, a.error].filter(Boolean).join(' · ')}</Text>}
                </View>
                {a.costPaise > 0 && <Text style={s.muted}>{formatINR(a.costPaise)}</Text>}
              </View>
            ))}
          </View>
        ))}
        {(g.retryable || runRetryable(String(r.status))) && (
          <Pressable style={[s.button, retry.isPending && { opacity: 0.5 }]} disabled={retry.isPending} onPress={() => retry.mutate()} accessibilityRole="button">
            <Text style={s.buttonText}>{t('m.auto.retry')}</Text></Pressable>
        )}
      </>}
    </View>
  );
}

// ---------- AI suggestions inbox ----------
export function AiInbox({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const q = useQuery({ queryKey: ['ai', 'suggestions', 'pending'], enabled: online,
    queryFn: async () => items(await unwrap(api.GET('/ai/suggestions', { params: { query: { status: 'pending', limit: 50 } } }))).map(toSuggestion) });
  if (!online) return <View><Header theme={theme} title={t('m.ai.title')} onBack={onBack} /><Text style={s.alert}>{t('m.auto.offline')}</Text></View>;
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />} contentContainerStyle={{ paddingBottom: 32 }}>
      <Header theme={theme} title={t('m.ai.title')} onBack={onBack} />
      {q.isLoading && <ActivityIndicator />}
      {q.error && <Text style={s.alert}>{errText(q.error)}</Text>}
      {!q.isLoading && !q.error && !(q.data ?? []).length && <Text style={s.muted}>{t('m.ai.empty')}</Text>}
      {(q.data ?? []).map((x) => (
        <Pressable key={x.id} style={s.row} onPress={() => nav.push({ name: 'aiSuggestion', id: x.id })} accessibilityRole="button">
          <View style={{ flex: 1 }}>
            <Text style={[s.chip, { alignSelf: 'flex-start' }]}>{t('m.ai.badge')}</Text>
            <Text style={s.text} numberOfLines={2}>{x.draft?.body ?? x.summary ?? x.classification?.category ?? x.kind}</Text>
            <Text style={s.muted}>{[x.kind, relativeTime(x.createdAt), x.sources.length ? `${t('m.ai.sources')}: ${x.sources.length}` : ''].filter(Boolean).join(' · ')}</Text>
          </View>
          <Feather name="chevron-right" size={18} color={theme.textMuted} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function SuggestionDetail({ theme, id, onBack }: { theme: Theme; id: string; onBack?: () => void }) {
  const q = useQuery({ queryKey: ['ai', 'suggestion', id], queryFn: async () => toSuggestion((await unwrap(api.GET('/ai/suggestions/{id}', { params: { path: { id } } }))) as Obj) });
  const s = ui(theme);
  return (
    <View>
      <Header theme={theme} title={t('m.ai.title')} onBack={onBack} />
      {q.isLoading && <ActivityIndicator />}
      {q.error && <Text style={s.alert}>{errText(q.error)}</Text>}
      {q.data && <SuggestionReview key={q.data.id} theme={theme} sug={q.data} onDone={onBack} />}
    </View>
  );
}

/** Review card: badge, sources, editable draft, approve (sends through the normal comm flow as the approver) / reject with reason. */
export function SuggestionReview({ theme, sug, onDone }: { theme: Theme; sug: Suggestion; onDone?: () => void }) {
  const s = ui(theme);
  const qcl = useQueryClient();
  const [body, setBody] = useState(sug.draft?.body ?? '');
  const [subject, setSubject] = useState(sug.draft?.subject ?? '');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState(sug.status);
  const done = (text: string, next: typeof status) => { setStatus(next); setMsg(text); void qcl.invalidateQueries({ queryKey: ['ai'] }); void qcl.invalidateQueries({ queryKey: ['timeline'] }); };
  const approve = useMutation({
    mutationFn: async () => {
      const b = approveBody(sug, sug.draft ? { body, subject: sug.draft.subject == null && !subject ? undefined : subject } : {});
      if (!b.ok) throw Object.assign(new Error(t('m.ai.emptyBody')), { code: 'empty_body' });
      return unwrap(api.POST('/ai/suggestions/{id}/approve', { params: { path: { id: sug.id } }, body: b.body as never }));
    },
    onSuccess: () => done(t('m.ai.approved'), 'approved'),
    onError: (e) => setMsg((e as { code?: string }).code === 'empty_body' ? t('m.ai.emptyBody') : errText(e)),
  });
  const reject = useMutation({
    mutationFn: () => unwrap(api.POST('/ai/suggestions/{id}/reject', { params: { path: { id: sug.id } }, body: rejectBody(reason) as never })),
    onSuccess: () => done(t('m.ai.rejected'), 'rejected'), onError: (e) => setMsg(errText(e)),
  });
  const acts = allowedActions(status);
  const busy = approve.isPending || reject.isPending;
  return (
    <View style={{ marginTop: 8, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Text style={[s.chip, { fontWeight: '600' }]} accessibilityRole="text">{t('m.ai.badge')}</Text>
        {sug.mock && <Text style={s.chip}>{t('m.ai.mock')}</Text>}
      </View>
      {sug.error && <Text style={[s.alert, { color: theme.status.overdue }]}>{t('m.ai.err.service', { reason: sug.error })}</Text>}
      {sug.summary && <><Text style={s.label}>{t('m.ai.summary')}</Text><Text style={s.text}>{sug.summary}</Text>
        {sug.points.map((p, i) => <Text key={i} style={s.text}>{`• ${p}`}</Text>)}</>}
      {sug.classification && <Text style={s.text}>{t('m.ai.classification', { category: sug.classification.category, fy: sug.classification.fy ?? '—' })}</Text>}
      {sug.draft && <>
        {sug.draft.subject != null && <><Text style={s.label}>{t('m.ai.subject')}</Text>
          <TextInput style={s.input} value={subject} onChangeText={setSubject} editable={acts.includes('approve')} accessibilityLabel={t('m.ai.subject')} /></>}
        <Text style={s.label}>{t('m.ai.draft')}</Text>
        <TextInput style={[s.input, { minHeight: 120, textAlignVertical: 'top' }]} multiline value={body} onChangeText={setBody} editable={acts.includes('approve')} accessibilityLabel={t('m.ai.draft')} />
        <Text style={s.muted}>{t('m.ai.sendHint')}</Text>
      </>}
      <Text style={s.label}>{t('m.ai.sources')}</Text>
      {!sug.sources.length && <Text style={s.muted}>{t('m.ai.noSources')}</Text>}
      {sug.sources.map((src, i) => <Text key={`${src.id}:${i}`} style={s.muted} numberOfLines={3}>{`${src.type}${src.label ? ` · ${src.label}` : ''}${src.snippet ? ` — ${src.snippet}` : ''}`}</Text>)}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {acts.includes('approve') && (
        <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => { setMsg(null); approve.mutate(); }} accessibilityRole="button">
          <Text style={s.buttonText}>{t(sug.draft ? 'm.ai.approveSend' : 'm.ai.approve')}</Text></Pressable>
      )}
      {acts.includes('reject') && <>
        <TextInput style={[s.input, { marginTop: 8 }]} value={reason} onChangeText={setReason} placeholder={t('m.ai.rejectReason')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.ai.rejectReason')} />
        <Pressable style={[s.ghost, { marginTop: 8 }]} disabled={busy} onPress={() => { setMsg(null); reject.mutate(); }} accessibilityRole="button"><Text style={s.ghostText}>{t('m.ai.reject')}</Text></Pressable>
      </>}
      {status !== sug.status && onDone && <Pressable style={[s.ghost, { marginTop: 8 }]} onPress={onDone} accessibilityRole="button"><Text style={s.ghostText}>{t('m.client.back')}</Text></Pressable>}
    </View>
  );
}

/** In-context AI on the client timeline: "Summarise" (header) and "Draft reply" (per inbound message). Never auto-sends. */
export function AiTimelineSummarise({ theme, clientId }: { theme: Theme; clientId: string }) {
  const visible = useAiVisible('summarise');
  const gen = useMutation({ mutationFn: async () => toSuggestion((await unwrap(api.POST('/ai/summaries', { body: { clientId } as never }))) as Obj) });
  return visible ? <AiAction theme={theme} icon="align-left" label={t('m.ai.summarise')} gen={gen} /> : null;
}
export function AiDraftReply({ theme, clientId, messageId, channel }: { theme: Theme; clientId: string; messageId: string; channel?: string | null }) {
  const visible = useAiVisible('draft_reply');
  const gen = useMutation({ mutationFn: async () => toSuggestion((await unwrap(api.POST('/ai/draft-reply', {
    body: { clientId, messageId, ...(channel === 'email' || channel === 'whatsapp' || channel === 'sms' ? { channel } : {}) } as never }))) as Obj) });
  return visible ? <AiAction theme={theme} icon="corner-up-left" label={t('m.ai.draftReply')} gen={gen} /> : null;
}
function AiAction({ theme, icon, label, gen }: { theme: Theme; icon: 'align-left' | 'corner-up-left'; label: string; gen: { mutate(): void; isPending: boolean; data?: Suggestion; error: unknown } }) {
  const s = ui(theme);
  return (
    <View>
      <Pressable style={[s.ghost, { alignSelf: 'flex-start', marginTop: 6 }, gen.isPending && { opacity: 0.5 }]} disabled={gen.isPending} onPress={() => gen.mutate()} accessibilityRole="button">
        <Feather name={icon} size={16} color={theme.primary} /><Text style={s.ghostText}>{gen.isPending ? t('m.ai.drafting') : label}</Text>
      </Pressable>
      {!!gen.error && <Text accessibilityRole="alert" style={[s.alert, { color: theme.status.overdue }]}>{errText(gen.error)}</Text>}
      {gen.data && <><Text style={s.muted}>{t('m.ai.ready')}</Text><SuggestionReview key={gen.data.id} theme={theme} sug={gen.data} /></>}
    </View>
  );
}
