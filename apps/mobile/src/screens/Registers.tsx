import { Feather } from '@expo/vector-icons';
import type { MessageKey } from '@worko/i18n';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { searchClients } from '../logic/clients';
import { buildRegisterPatch, INWARD_MODES, OUTWARD_MODES, REGISTER_TABLE, searchEntries, todayIST, toEntryItems, type RegisterKind } from '../logic/registers';
import { loadSigQueue, submitSignature } from '../net';
import { getEngine, syncNow, useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui, useTable } from '../ui';
import { useClientItems } from './Clients';
import { Header } from './Header';
import { SignaturePad } from './SignaturePad';
import type { Nav } from './Stack';

function KindToggle({ theme, kind, onChange }: { theme: Theme; kind: RegisterKind; onChange(k: RegisterKind): void }) {
  const s = ui(theme);
  return (
    <View style={{ flexDirection: 'row', gap: 6, marginVertical: 8 }} accessibilityRole="tablist">
      {(['inward', 'outward'] as const).map((k) => (
        <Pressable key={k} onPress={() => onChange(k)} style={[s.chipBtn, { flex: 1, alignItems: 'center' }, kind === k && { backgroundColor: theme.primary, borderColor: theme.primary }]}
          accessibilityRole="tab" accessibilityState={{ selected: kind === k }}>
          <Text style={{ color: kind === k ? theme.primaryText : theme.text, fontWeight: '600' }}>{t(k === 'inward' ? 'm.reg.inward' : 'm.reg.outward')}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function usePendingSigs(): Set<string> {
  const v = useSync((x) => x.versions.pending_signatures ?? 0);
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => { let live = true; void loadSigQueue().then((q) => { if (live) setIds(new Set(q.map((x) => x.entryId))); }); return () => { live = false; }; }, [v]);
  return ids;
}

export function RegisterList({ theme, nav, clientId, onBack }: { theme: Theme; nav: Nav; clientId?: string; onBack?: () => void }) {
  const s = ui(theme);
  const [kind, setKind] = useState<RegisterKind>('inward');
  const [q, setQ] = useState('');
  const rows = useTable(REGISTER_TABLE[kind]);
  const clients = useClientItems();
  const names = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const items = useMemo(() => toEntryItems(kind, rows, (id) => names.get(id) ?? ''), [kind, rows, names]);
  const shown = useMemo(() => searchEntries(items, q, clientId), [items, q, clientId]);
  const pendingSigs = usePendingSigs();
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={clientId ? `${t('m.reg.title')} · ${names.get(clientId) ?? ''}` : t('m.reg.title')} onBack={onBack} right={
        <Pressable style={s.icon} onPress={() => nav.push({ name: 'regForm', kind, clientId })} accessibilityRole="button" accessibilityLabel={t('m.reg.add')}>
          <Feather name="plus" size={24} color={theme.primary} /></Pressable>} />
      <KindToggle theme={theme} kind={kind} onChange={setKind} />
      <TextInput style={s.input} value={q} onChangeText={setQ} placeholder={t('m.reg.search')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('common.search')} autoCorrect={false} />
      <FlatList data={shown} keyExtractor={(x) => x.id} initialNumToRender={20} keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.reg.empty')}</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => nav.push({ name: 'entry', kind, id: item.id })} accessibilityRole="button">
            <View style={{ flex: 1 }}>
              <Text style={[s.text, !item.number && { fontStyle: 'italic' }]}>{item.number ?? t('m.reg.numberPending')} · {item.date}</Text>
              <Text style={s.muted} numberOfLines={1}>{[names.get(item.clientId), item.party, item.description].filter(Boolean).join(' · ')}</Text>
            </View>
            {item.signed ? <Feather name="check-circle" size={18} color={theme.status.done} accessibilityLabel={t('m.reg.signed')} />
              : pendingSigs.has(item.id) ? <Feather name="upload-cloud" size={18} color={theme.textMuted} accessibilityLabel={t('m.reg.sigPending')} /> : null}
          </Pressable>
        )} />
    </View>
  );
}

const FIELD_KEY: Record<string, MessageKey> = { client: 'm.reg.client', mode: 'm.reg.mode', description: 'm.reg.description', date: 'm.reg.date', phone: 'm.reg.phone', dueBack: 'm.reg.dueBack' };

/** Works fully offline: optimistic local insert + outbox; the server assigns number/FY on sync. */
export function RegisterForm({ theme, nav, kind, clientId: fixedClient, onBack }: { theme: Theme; nav: Nav; kind: RegisterKind; clientId?: string; onBack?: () => void }) {
  const s = ui(theme);
  const clients = useClientItems();
  const [clientId, setClientId] = useState(fixedClient ?? '');
  const [clientQ, setClientQ] = useState('');
  const modes: readonly string[] = kind === 'inward' ? INWARD_MODES : OUTWARD_MODES;
  const [mode, setMode] = useState<string>(modes[0]!);
  const [date, setDate] = useState(todayIST());
  const [party, setParty] = useState('');
  const [phone, setPhone] = useState('');
  const [description, setDescription] = useState('');
  const [itemsText, setItemsText] = useState('');
  const [returnable, setReturnable] = useState(false);
  const [original, setOriginal] = useState(false);
  const [dueBack, setDueBack] = useState('');
  const [courierName, setCourierName] = useState('');
  const [trackingNo, setTrackingNo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const client = clients.find((c) => c.id === clientId);
  const matches = useMemo(() => (clientQ ? searchClients(clients, clientQ).slice(0, 8) : []), [clients, clientQ]);

  async function save() {
    const r = buildRegisterPatch(kind, {
      clientId, date, mode, party, phone, description, returnable, dueBack: dueBack || undefined, original, courierName, trackingNo,
      items: itemsText.split('\n').map((d) => ({ description: d, original: kind === 'inward' ? returnable : original })),
    });
    if (!r.ok) { setError(t('m.reg.invalid', { fields: r.errors.map((e) => t(FIELD_KEY[e]!)).join(', ') })); return; }
    const engine = getEngine();
    if (!engine) { setError(t('common.error')); return; }
    const id = Crypto.randomUUID();
    await engine.write(REGISTER_TABLE[kind], id, r.patch);
    void syncNow();
    Alert.alert(t('m.reg.saved'));
    nav.replace({ name: 'entry', kind, id });
  }

  return (
    <View>
      <Header theme={theme} title={t(kind === 'inward' ? 'm.client.newInward' : 'm.client.newOutward')} onBack={onBack} />
      {error && <Text accessibilityRole="alert" style={s.alert}>{error}</Text>}
      <Text style={s.label}>{t('m.reg.client')}</Text>
      {client ? (
        <View style={s.row}>
          <Text style={[s.text, { flex: 1 }]}>{client.name}</Text>
          {!fixedClient && <Pressable style={s.icon} onPress={() => setClientId('')} accessibilityRole="button" accessibilityLabel={t('m.reg.pickClient')}>
            <Feather name="x" size={18} color={theme.textMuted} /></Pressable>}
        </View>
      ) : (
        <View>
          <TextInput style={s.input} value={clientQ} onChangeText={setClientQ} placeholder={t('m.clients.search')} placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.reg.pickClient')} autoCorrect={false} />
          {matches.map((c) => (
            <Pressable key={c.id} style={s.row} onPress={() => { setClientId(c.id); setClientQ(''); }} accessibilityRole="button">
              <Text style={s.text}>{c.name}</Text><Text style={[s.muted, { marginLeft: 8 }]}>{c.pan}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Text style={s.label}>{t('m.reg.date')}</Text>
      <TextInput style={s.input} value={date} onChangeText={setDate} keyboardType="numbers-and-punctuation" accessibilityLabel={t('m.reg.date')} />
      <Text style={s.label}>{t('m.reg.mode')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {modes.map((m) => (
          <Pressable key={m} onPress={() => setMode(m)} style={[s.chipBtn, mode === m && { backgroundColor: theme.primary, borderColor: theme.primary }]}
            accessibilityRole="radio" accessibilityState={{ checked: mode === m }}>
            <Text style={{ color: mode === m ? theme.primaryText : theme.text }}>{t(`m.mode.${m}` as MessageKey)}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.label}>{t(kind === 'inward' ? 'm.reg.from' : 'm.reg.to')}</Text>
      <TextInput style={s.input} value={party} onChangeText={setParty} accessibilityLabel={t(kind === 'inward' ? 'm.reg.from' : 'm.reg.to')} />
      <Text style={s.label}>{t('m.reg.phone')}</Text>
      <TextInput style={s.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+91" placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.reg.phone')} />
      {kind === 'outward' && mode === 'courier' && <>
        <Text style={s.label}>{t('m.reg.courier')}</Text>
        <TextInput style={s.input} value={courierName} onChangeText={setCourierName} accessibilityLabel={t('m.reg.courier')} />
        <Text style={s.label}>{t('m.reg.tracking')}</Text>
        <TextInput style={s.input} value={trackingNo} onChangeText={setTrackingNo} autoCapitalize="characters" accessibilityLabel={t('m.reg.tracking')} />
      </>}
      <Text style={s.label}>{t('m.reg.description')}</Text>
      <TextInput style={[s.input, { minHeight: 72, textAlignVertical: 'top' }]} value={description} onChangeText={setDescription} multiline accessibilityLabel={t('m.reg.description')} />
      <Text style={s.label}>{t('m.reg.items')}</Text>
      <TextInput style={[s.input, { minHeight: 72, textAlignVertical: 'top' }]} value={itemsText} onChangeText={setItemsText} multiline accessibilityLabel={t('m.reg.items')} />
      <Toggle theme={theme} label={t(kind === 'inward' ? 'm.reg.returnable' : 'm.reg.receivedBack')} value={returnable} onChange={setReturnable} />
      {kind === 'outward' && <Toggle theme={theme} label={t('m.reg.original')} value={original} onChange={setOriginal} />}
      {kind === 'inward' && returnable && <>
        <Text style={s.label}>{t('m.reg.dueBack')}</Text>
        <TextInput style={s.input} value={dueBack} onChangeText={setDueBack} keyboardType="numbers-and-punctuation" accessibilityLabel={t('m.reg.dueBack')} />
      </>}
      <Pressable style={s.button} onPress={() => void save()} accessibilityRole="button"><Text style={s.buttonText}>{t('common.save')}</Text></Pressable>
    </View>
  );
}

function Toggle({ theme, label, value, onChange }: { theme: Theme; label: string; value: boolean; onChange(v: boolean): void }) {
  const s = ui(theme);
  return (
    <View style={[s.row, { borderBottomWidth: 0 }]}>
      <Text style={[s.text, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

export function EntryDetail({ theme, kind, id, onBack }: { theme: Theme; kind: RegisterKind; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const row = useTable(REGISTER_TABLE[kind]).find((r) => r.id === id);
  const clients = useClientItems();
  const pending = usePendingSigs().has(id);
  const [signing, setSigning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!row) return <View><Header theme={theme} title="" onBack={onBack} /><Text style={s.muted}>{t('common.loading')}</Text></View>;
  const f = row.fields;
  const items = (Array.isArray(f.items) ? f.items : []) as Array<{ description?: string; qty?: number }>;
  const line = (k: MessageKey, v: unknown) => (v ? <Text style={s.text}><Text style={s.muted}>{t(k)}: </Text>{String(v)}</Text> : null);
  async function onSave(uri: string) {
    setSigning(false);
    const now = await submitSignature(kind, id, uri);
    setMsg(t(now ? 'm.sig.uploaded' : 'm.sig.queued'));
  }
  return (
    <View>
      <Header theme={theme} title={f.number ? String(f.number) : t('m.reg.numberPending')} onBack={onBack} />
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {line('m.reg.client', clients.find((c) => c.id === f.client_id)?.name)}
      {line('m.reg.date', kind === 'inward' ? f.received_on : f.sent_on)}
      {line('m.reg.mode', f.mode ? t(`m.mode.${String(f.mode)}` as MessageKey) : '')}
      {line(kind === 'inward' ? 'm.reg.from' : 'm.reg.to', kind === 'inward' ? f.from_name : f.to_name)}
      {line('m.reg.phone', kind === 'inward' ? f.from_phone : f.to_phone)}
      {line('m.reg.courier', f.courier_name)}
      {line('m.reg.tracking', f.tracking_no)}
      {line('m.reg.description', f.description)}
      {items.map((i, n) => <Text key={n} style={s.text}>• {i.description}{i.qty && i.qty > 1 ? ` × ${i.qty}` : ''}</Text>)}
      {line('m.reg.dueBack', f.due_back)}
      {f.signature_doc_id ? <Text style={[s.text, { marginTop: 12, color: theme.status.done }]}>{t('m.reg.signed')}</Text>
        : pending ? <Text style={[s.muted, { marginTop: 12 }]}>{t('m.reg.sigPending')}</Text> : null}
      {signing ? <SignaturePad theme={theme} onSave={(u) => void onSave(u)} onCancel={() => setSigning(false)} />
        : !f.signature_doc_id && <Pressable style={s.button} onPress={() => { setMsg(null); setSigning(true); }} accessibilityRole="button">
          <Text style={s.buttonText}>{t('m.reg.sign')}</Text></Pressable>}
    </View>
  );
}
