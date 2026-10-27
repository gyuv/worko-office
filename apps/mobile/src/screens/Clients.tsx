import { Feather } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Alert, FlatList, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { searchClients, toClientItems, type ClientItem } from '../logic/clients';
import { telLink, whatsappLink } from '../logic/links';
import { openDocument } from '../net';
import { useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui, useTable } from '../ui';
import { Header } from './Header';
import type { Nav } from './Stack';
import type { MessageKey } from '@worko/i18n';

const STATUSES = ['', 'active', 'prospect', 'inactive'] as const;
const statusKey = (s: string): MessageKey => (s === 'active' || s === 'inactive' || s === 'prospect' ? `m.status.${s}` : 'm.status.all');

export function useClientItems(): ClientItem[] {
  const clients = useTable('client');
  const regs = useTable('client_registration');
  return useMemo(() => toClientItems(clients, regs), [clients, regs]);
}

export function StatusChip({ theme, status }: { theme: Theme; status: string }) {
  const color = status === 'active' ? theme.status.done : status === 'inactive' ? theme.textMuted : theme.status.inProgress;
  return <Text style={[ui(theme).chip, { color }]}>{STATUSES.includes(status as never) && status ? t(statusKey(status)) : status}</Text>;
}

/** Offline list from the local store; FlatList virtualises so thousands of rows stay smooth. */
export function ClientList({ theme, nav }: { theme: Theme; nav: Nav }) {
  const s = ui(theme);
  const items = useClientItems();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const shown = useMemo(() => searchClients(items, q, status || undefined), [items, q, status]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('nav.clients')} right={
        <Pressable style={s.icon} onPress={() => nav.push({ name: 'registers' })} accessibilityRole="button" accessibilityLabel={t('m.reg.title')}>
          <Feather name="book" size={20} color={theme.primary} />
        </Pressable>} />
      <TextInput style={s.input} value={q} onChangeText={setQ} placeholder={t('m.clients.search')} placeholderTextColor={theme.textMuted}
        accessibilityLabel={t('common.search')} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" />
      <View style={{ flexDirection: 'row', gap: 6, marginVertical: 8, flexWrap: 'wrap' }}>
        {STATUSES.map((x) => (
          <Pressable key={x} onPress={() => setStatus(x)} style={[s.chipBtn, status === x && { backgroundColor: theme.primary, borderColor: theme.primary }]}
            accessibilityRole="button" accessibilityState={{ selected: status === x }}>
            <Text style={{ color: status === x ? theme.primaryText : theme.text }}>{t(statusKey(x))}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.muted}>{t('m.clients.count', { count: shown.length })}</Text>
      <FlatList data={shown} keyExtractor={(x) => x.id} initialNumToRender={20} maxToRenderPerBatch={30} windowSize={11} removeClippedSubviews
        getItemLayout={(_, i) => ({ length: ROW_H, offset: ROW_H * i, index: i })} keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{items.length ? t('m.clients.noMatch') : t('m.clients.empty')}</Text>}
        renderItem={({ item }) => <ClientRow theme={theme} item={item} onPress={() => nav.push({ name: 'client', id: item.id })} />} />
    </View>
  );
}

const ROW_H = 64;
function ClientRow({ theme, item, onPress }: { theme: Theme; item: ClientItem; onPress(): void }) {
  const s = ui(theme);
  const sub = [item.fileNo, item.pan, item.gstins[0]].filter(Boolean).join(' · ');
  return (
    <Pressable style={[s.row, { height: ROW_H }]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${item.name} ${sub}`}>
      <View style={{ flex: 1 }}>
        <Text style={s.text} numberOfLines={1}>{item.name}</Text>
        <Text style={s.muted} numberOfLines={1}>{sub || item.tradeName}</Text>
      </View>
      <StatusChip theme={theme} status={item.status} />
    </Pressable>
  );
}

type Addr = { kind?: string; line1?: string; line2?: string; city?: string; state?: string; pin?: string };

export function ClientDetail({ theme, nav, id, onBack }: { theme: Theme; nav: Nav; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const client = useTable('client').find((r) => r.id === id);
  const regs = useTable('client_registration').filter((r) => r.fields.client_id === id);
  const contacts = useTable('contact').filter((r) => r.fields.client_id === id)
    .sort((a, b) => Number(!!b.fields.is_primary) - Number(!!a.fields.is_primary));
  const docs = useTable('document').filter((r) => r.fields.client_id === id)
    .sort((a, b) => String(b.fields.created_at ?? '').localeCompare(String(a.fields.created_at ?? '')));
  if (!client) return <View><Header theme={theme} title="" onBack={onBack} /><Text style={s.muted}>{t('common.loading')}</Text></View>;
  const f = client.fields;
  const gstins = regs.filter((r) => r.fields.kind === 'GSTIN').map((r) => String(r.fields.number));
  const addresses = (Array.isArray(f.addresses) ? f.addresses : []) as Addr[];
  const open = async (docId: string) => {
    if (!online) { Alert.alert(t('m.doc.offline')); return; }
    try { await openDocument(docId); } catch { Alert.alert(t('m.doc.openFailed')); }
  };
  const link = (url: string | null) => { if (url) void Linking.openURL(url); };

  return (
    <FlatList data={docs} keyExtractor={(d) => d.id} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}
      ListHeaderComponent={<View>
        <Header theme={theme} title={String(f.name ?? '')} onBack={onBack} right={<StatusChip theme={theme} status={String(f.status ?? 'active')} />} />
        {!!f.trade_name && <Text style={s.muted}>{String(f.trade_name)}</Text>}
        {!!f.pan && <Text style={s.text} selectable>{t('m.client.pan')}: {String(f.pan)}</Text>}
        {gstins.map((g) => <Text key={g} style={s.text} selectable>{t('m.client.gstins')}: {g}</Text>)}
        {!!f.file_no && <Text style={s.muted}>{t('m.client.fileNo')}: {String(f.file_no)}</Text>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <Pressable style={s.ghost} onPress={() => nav.push({ name: 'regForm', kind: 'inward', clientId: id })} accessibilityRole="button">
            <Feather name="log-in" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.client.newInward')}</Text></Pressable>
          <Pressable style={s.ghost} onPress={() => nav.push({ name: 'regForm', kind: 'outward', clientId: id })} accessibilityRole="button">
            <Feather name="log-out" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.client.newOutward')}</Text></Pressable>
          <Pressable style={s.ghost} onPress={() => nav.push({ name: 'registers', clientId: id })} accessibilityRole="button">
            <Feather name="book" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.client.registers')}</Text></Pressable>
        </View>

        <Text style={s.h2}>{t('m.client.contacts')}</Text>
        {!contacts.length && <Text style={s.muted}>{t('m.client.noContacts')}</Text>}
        {contacts.map((c) => {
          const name = String(c.fields.name ?? '');
          const phone = String(c.fields.phone ?? ''); const wa = String(c.fields.whatsapp ?? '') || phone;
          return (
            <View key={c.id} style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.text}>{name}{c.fields.is_primary ? ` · ${t('m.client.primary')}` : ''}</Text>
                <Text style={s.muted}>{[c.fields.role, phone, c.fields.email].filter(Boolean).join(' · ')}</Text>
              </View>
              {!!telLink(phone) && <Pressable style={s.icon} onPress={() => link(telLink(phone))} accessibilityRole="button" accessibilityLabel={t('m.client.call', { name })}>
                <Feather name="phone" size={20} color={theme.primary} /></Pressable>}
              {!!whatsappLink(wa) && <Pressable style={s.icon} onPress={() => link(whatsappLink(wa))} accessibilityRole="button" accessibilityLabel={t('m.client.whatsapp', { name })}>
                <Feather name="message-circle" size={20} color={theme.primary} /></Pressable>}
            </View>
          );
        })}
        {!!f.phone && !contacts.length && (
          <View style={s.row}>
            <Text style={[s.text, { flex: 1 }]}>{String(f.phone)}</Text>
            <Pressable style={s.icon} onPress={() => link(telLink(String(f.phone)))} accessibilityRole="button" accessibilityLabel={t('m.client.call', { name: String(f.name) })}>
              <Feather name="phone" size={20} color={theme.primary} /></Pressable>
            <Pressable style={s.icon} onPress={() => link(whatsappLink(String(f.phone)))} accessibilityRole="button" accessibilityLabel={t('m.client.whatsapp', { name: String(f.name) })}>
              <Feather name="message-circle" size={20} color={theme.primary} /></Pressable>
          </View>
        )}

        {!!addresses.length && <Text style={s.h2}>{t('m.client.addresses')}</Text>}
        {addresses.map((a, i) => (
          <Text key={i} style={[s.text, { marginBottom: 6 }]} selectable>
            {[a.line1, a.line2, a.city, a.state, a.pin].filter(Boolean).join(', ')}{a.kind ? `  (${a.kind})` : ''}
          </Text>
        ))}

        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[s.h2, { flex: 1 }]}>{t('m.client.documents')}</Text>
          <Pressable style={s.ghost} onPress={() => nav.push({ name: 'upload', clientId: id })} accessibilityRole="button">
            <Feather name="camera" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.client.scan')}</Text></Pressable>
        </View>
        {!docs.length && <Text style={s.muted}>{t('m.client.noDocuments')}</Text>}
      </View>}
      renderItem={({ item: d }) => {
        const name = String(d.fields.name ?? '');
        return (
          <Pressable style={s.row} onPress={() => void open(d.id)} accessibilityRole="button" accessibilityLabel={t('m.doc.open', { name })}>
            <Feather name="file-text" size={18} color={theme.textMuted} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.text} numberOfLines={1}>{name}</Text>
              <Text style={s.muted}>{[d.fields.category, d.fields.fy].filter(Boolean).join(' · ')}</Text>
            </View>
          </Pressable>
        );
      }} />
  );
}
