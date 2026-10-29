import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, LEAD_ACTIVITY_KINDS, type LeadStage } from '@worko/domain';
import { relativeTime, type MessageKey } from '@worko/i18n';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { hasGrant } from '../logic/billing';
import { applyMove, followupState, groupBoard, isYmd, moveBody, moveTargets, toLeadItem, type Column, type LeadItem, type MoveCheck } from '../logic/leads';
import { telLink, whatsappLink } from '../logic/links';
import { api, unwrap } from '../session';
import type { Theme } from '../theme';
import { t, ui } from '../ui';
import { Header } from './Header';
import type { Nav } from './Stack';

/** Leads pipeline on Android (Phase 9, D131/D134): online REST, no sync. Board = stages as horizontal sections. */

const BOARD_KEY = ['leads', 'board'];
const stageLabel = (s: LeadStage) => t(`m.lead.stage.${s}` as MessageKey);
const errKey = (code: MoveCheck | string | undefined): MessageKey => (['convert_to_win', 'lost_reason_required', 'lead_won_final', 'invalid_transition'].includes(String(code)) ? (`m.lead.err.${code}` as MessageKey) : 'm.lead.err.generic');

export function useLeadPerms() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')) }).data;
  return { view: hasGrant(me?.grants, 'leads', 'view'), edit: hasGrant(me?.grants, 'leads', 'edit') };
}

function useBoard() {
  return useQuery({
    queryKey: BOARD_KEY,
    queryFn: async () => groupBoard((await unwrap(api.GET('/leads/board'))).flatMap((c) => (c.items ?? []).map((l) => toLeadItem(l as Record<string, unknown>)))),
  });
}

export function LeadBoard({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const q = useBoard();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ won: true, lost: true });
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.lead.title')} onBack={onBack} />
      {q.error && <Text style={s.alert}>{t('m.lead.loadFailed', { reason: (q.error as Error).message })}</Text>}
      {q.isLoading && <ActivityIndicator />}
      <ScrollView refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}>
        {(q.data ?? []).map((col) => (
          <View key={col.stage} style={{ marginBottom: 8 }}>
            <Pressable style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }} onPress={() => setCollapsed({ ...collapsed, [col.stage]: !collapsed[col.stage] })} accessibilityRole="button"
              accessibilityState={{ expanded: !collapsed[col.stage] }}>
              <Feather name={collapsed[col.stage] ? 'chevron-right' : 'chevron-down'} size={18} color={theme.textMuted} />
              <Text style={[s.h2, { marginTop: 0, marginBottom: 0, flex: 1 }]}>{stageLabel(col.stage)} · {col.items.length}</Text>
              {col.valuePaise > 0 && <Text style={s.muted}>{formatINR(col.valuePaise)}</Text>}
            </Pressable>
            {!collapsed[col.stage] && (col.items.length === 0 ? <Text style={[s.muted, { marginLeft: 24 }]}>{t('m.lead.emptyStage')}</Text> : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                {col.items.map((l) => <LeadCard key={l.id} theme={theme} lead={l} onPress={() => nav.push({ name: 'lead', id: l.id })} />)}
              </ScrollView>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function LeadCard({ theme, lead, onPress }: { theme: Theme; lead: LeadItem; onPress(): void }) {
  const s = ui(theme);
  const f = followupState(lead);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={{ width: 220, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}>
      <Text style={[s.text, { fontWeight: '600' }]} numberOfLines={1}>{lead.name}</Text>
      {!!lead.company && <Text style={s.muted} numberOfLines={1}>{lead.company}</Text>}
      {lead.expectedValuePaise > 0 && <Text style={s.text}>{formatINR(lead.expectedValuePaise)}</Text>}
      {f && <Text style={{ fontSize: 12, color: f === 'overdue' ? theme.status.overdue : theme.textMuted }}>{t(`m.lead.followup.${f}` as MessageKey, { date: lead.nextFollowupOn ?? '' })}</Text>}
    </Pressable>
  );
}

type LeadDetailData = LeadItem & { activities: Array<{ id: string; kind: string; body: string; at: string }>; proposals: Array<{ id: string; number: string; title: string | null; status: string; currentVersion: number; sentVersion: number | null }> };

export function LeadDetail({ theme, id, onBack }: { theme: Theme; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const qcl = useQueryClient();
  const perms = useLeadPerms();
  const q = useQuery({ queryKey: ['leads', 'detail', id], queryFn: async () => {
    const r = (await unwrap(api.GET('/leads/{id}', { params: { path: { id } } }))) as Record<string, unknown>;
    return { ...toLeadItem(r), activities: (r.activities ?? []) as LeadDetailData['activities'], proposals: (r.proposals ?? []) as LeadDetailData['proposals'] } as LeadDetailData;
  } });
  const board = qcl.getQueryData<Column[]>(BOARD_KEY);
  const [picker, setPicker] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [kind, setKind] = useState<(typeof LEAD_ACTIVITY_KINDS)[number]>('note');
  const [note, setNote] = useState('');
  const [followup, setFollowup] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => { void qcl.invalidateQueries({ queryKey: ['leads'] }); };

  const move = useMutation({
    mutationFn: async (to: LeadStage) => {
      const l = q.data!;
      const body = moveBody(board ?? groupBoard([l]), l, to, lostReason);
      if (board) qcl.setQueryData(BOARD_KEY, applyMove(board, l, to)); // optimistic
      return unwrap(api.POST('/leads/{id}/move', { params: { path: { id } }, body }));
    },
    onSuccess: () => { setPicker(false); setLostReason(''); setMsg(t('m.lead.moved')); refresh(); },
    onError: (e) => { setMsg(t(errKey((e as { code?: string }).code))); refresh(); },
  });
  const addNote = useMutation({
    mutationFn: async () => {
      if (note.trim()) await unwrap(api.POST('/leads/{id}/activities', { params: { path: { id } }, body: { kind, body: note.trim() } }));
      if (followup) await unwrap(api.PATCH('/leads/{id}', { params: { path: { id } }, body: { nextFollowupOn: followup } }));
    },
    onSuccess: () => { setNote(''); setFollowup(''); setMsg(t('m.lead.saved')); refresh(); },
    onError: (e) => setMsg(t('m.lead.saveFailed', { reason: (e as Error).message })),
  });
  const targets = useMemo(() => (q.data ? moveTargets(q.data) : []), [q.data]);
  const l = q.data;
  if (!l) return <View><Header theme={theme} title={t('m.lead.title')} onBack={onBack} />{q.error ? <Text style={s.alert}>{(q.error as Error).message}</Text> : <ActivityIndicator />}</View>;
  const tel = l.phone ? telLink(l.phone) : null; const wa = l.phone ? whatsappLink(l.phone) : null;
  const fuOk = !followup || isYmd(followup);
  return (
    <View>
      <Header theme={theme} title={l.name} onBack={onBack} />
      {!!l.company && <Text style={s.muted}>{l.company}</Text>}
      <Text style={s.text}>{stageLabel(l.stage)}{l.expectedValuePaise ? ` · ${formatINR(l.expectedValuePaise)}` : ''}</Text>
      {l.stage === 'lost' && !!l.lostReason && <Text style={s.muted}>{t('m.lead.lostBecause', { reason: l.lostReason })}</Text>}
      {l.nextFollowupOn && <Text style={s.muted}>{t('m.lead.nextFollowup', { date: l.nextFollowupOn })}</Text>}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {tel && <Pressable style={s.ghost} onPress={() => void Linking.openURL(tel)} accessibilityRole="button"><Feather name="phone" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.lead.call')}</Text></Pressable>}
        {wa && <Pressable style={s.ghost} onPress={() => void Linking.openURL(wa)} accessibilityRole="button"><Feather name="message-circle" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.lead.whatsapp')}</Text></Pressable>}
        {l.email && <Pressable style={s.ghost} onPress={() => void Linking.openURL(`mailto:${l.email}`)} accessibilityRole="button"><Feather name="mail" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.lead.email')}</Text></Pressable>}
        {perms.edit && <Pressable style={s.ghost} onPress={() => setPicker(!picker)} accessibilityRole="button" accessibilityState={{ expanded: picker }}><Feather name="shuffle" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.lead.move')}</Text></Pressable>}
      </View>
      {picker && <View style={{ marginTop: 8 }}>
        {targets.map((x) => (
          <Pressable key={x.stage} style={[s.row, x.blocked && { opacity: 0.5 }]} disabled={!!x.blocked || move.isPending || (x.needsReason && !lostReason.trim())}
            onPress={() => move.mutate(x.stage)} accessibilityRole="button" accessibilityState={{ disabled: !!x.blocked }}>
            <Text style={[s.text, { flex: 1 }]}>{stageLabel(x.stage)}</Text>
            {x.blocked ? <Text style={s.muted}>{t(errKey(x.blocked))}</Text> : x.needsReason && !lostReason.trim() ? <Text style={s.muted}>{t('m.lead.err.lost_reason_required')}</Text> : null}
          </Pressable>
        ))}
        {targets.some((x) => x.needsReason && !x.blocked) && <>
          <Text style={s.label}>{t('m.lead.lostReason')}</Text>
          <TextInput style={s.input} value={lostReason} onChangeText={setLostReason} maxLength={500} accessibilityLabel={t('m.lead.lostReason')} />
        </>}
      </View>}
      {perms.edit && <>
        <Text style={s.h2}>{t('m.lead.addActivity')}</Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {LEAD_ACTIVITY_KINDS.map((k) => (
            <Pressable key={k} onPress={() => setKind(k)} style={[s.chipBtn, kind === k && { backgroundColor: theme.primary, borderColor: theme.primary }]} accessibilityRole="radio" accessibilityState={{ checked: kind === k }}>
              <Text style={{ color: kind === k ? theme.primaryText : theme.text }}>{t(`m.lead.kind.${k}` as MessageKey)}</Text></Pressable>
          ))}
        </View>
        <TextInput style={[s.input, { marginTop: 8, minHeight: 72, textAlignVertical: 'top', paddingTop: 10 }]} multiline value={note} onChangeText={setNote} maxLength={5000} placeholder={t('m.lead.notePlaceholder')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.lead.addActivity')} />
        <Text style={s.label}>{t('m.lead.followupOn')}</Text>
        <TextInput style={s.input} value={followup} onChangeText={setFollowup} placeholder="YYYY-MM-DD" placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.lead.followupOn')} />
        <Pressable style={[s.button, (addNote.isPending || !fuOk || (!note.trim() && !followup)) && { opacity: 0.5 }]} disabled={addNote.isPending || !fuOk || (!note.trim() && !followup)} onPress={() => addNote.mutate()} accessibilityRole="button">
          <Text style={s.buttonText}>{t('m.lead.save')}</Text></Pressable>
      </>}
      <Text style={s.h2}>{t('m.lead.proposals')}</Text>
      {l.proposals.length === 0 && <Text style={s.muted}>{t('m.lead.noProposals')}</Text>}
      {l.proposals.map((p) => (
        <View key={p.id} style={s.row}>
          <View style={{ flex: 1 }}><Text style={s.text}>{p.number}{p.title ? ` · ${p.title}` : ''}</Text><Text style={s.muted}>{t('m.lead.version', { v: p.currentVersion })}{p.sentVersion ? ` · ${t('m.lead.sentV', { v: p.sentVersion })}` : ''}</Text></View>
          <Text style={s.chip}>{t(`m.lead.pstatus.${p.status}` as MessageKey)}</Text>
        </View>
      ))}
      <Text style={s.h2}>{t('m.lead.activity')}</Text>
      {l.activities.length === 0 && <Text style={s.muted}>{t('m.lead.noActivity')}</Text>}
      {l.activities.map((a) => (
        <View key={a.id} style={s.row}><View style={{ flex: 1 }}><Text style={s.text}>{a.body}</Text><Text style={s.muted}>{t(`m.lead.kind.${a.kind}` as MessageKey)} · {relativeTime(a.at)}</Text></View></View>
      ))}
      <Text style={[s.muted, { marginTop: 12 }]}>{t('m.lead.webHint')}</Text>
    </View>
  );
}
