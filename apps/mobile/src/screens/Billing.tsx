import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, Share, Text, TextInput, View } from 'react-native';
import {
  allocationPreview, buildReceipt, clientOutstanding, collectionsToday, daysOverdue, filterInvoices, hasGrant, isOpen, isOverdue, RECEIPT_MODES,
  toInvoiceItems, type InvoiceFilter, type InvoiceItem, type ReceiptError, type ReceiptForm,
} from '../logic/billing';
import { todayIST } from '../logic/registers';
import { createPaymentLink, latestPaymentLink, openInvoicePdf, recordReceipt } from '../net';
import { api, unwrap } from '../session';
import { useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui, useTable } from '../ui';
import { useClientItems } from './Clients';
import { Header } from './Header';
import type { Nav } from './Stack';

const money = (p: number) => formatINR(p);

export function useInvoices(): InvoiceItem[] {
  const rows = useTable('invoice');
  return useMemo(() => toInvoiceItems(rows), [rows]);
}
function useClientNames() {
  const clients = useClientItems();
  return useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
}
/** UI gating from /me grants (server enforces). Cached by react-query; offline cold start ⇒ no actions, lists still render from sync. */
export function useBillingPerms() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/me')) }).data;
  const g = me?.grants;
  return {
    view: hasGrant(g, 'billing', 'view'), print: hasGrant(g, 'billing', 'print'), link: hasGrant(g, 'billing', 'edit'),
    receipt: hasGrant(g, 'receipts', 'create'),
  };
}

const statusKey = (i: InvoiceItem): MessageKey =>
  i.kind === 'credit_note' ? 'm.bill.kind.credit_note' : i.kind === 'debit_note' && i.status !== 'paid' ? 'm.bill.kind.debit_note' : `m.bill.status.${i.status}`;

function InvoiceRow({ theme, item, client, today, onPress }: { theme: Theme; item: InvoiceItem; client?: string; today: string; onPress(): void }) {
  const s = ui(theme);
  const days = isOverdue(item, today) ? daysOverdue(item, today) : 0;
  return (
    <Pressable style={s.row} onPress={onPress} accessibilityRole="button">
      <View style={{ width: 4, alignSelf: 'stretch', marginRight: 10, borderRadius: 2,
        backgroundColor: days ? theme.status.overdue : isOpen(item) ? theme.status.inProgress : theme.status.done }} />
      <View style={{ flex: 1 }}>
        <Text style={s.text} numberOfLines={1}>{item.number ?? '—'} · {client ?? item.billToName}</Text>
        <Text style={s.muted} numberOfLines={1}>{[t(statusKey(item)), item.dueDate ? t('m.bill.dueOn', { date: item.dueDate }) : null].filter(Boolean).join(' · ')}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={s.text}>{money(isOpen(item) ? item.balancePaise : item.totalPaise)}</Text>
        {!!days && <Text style={[s.chip, { color: theme.status.overdue }]}>{t('m.bill.overdueDays', { days })}</Text>}
      </View>
    </Pressable>
  );
}

const FILTERS: InvoiceFilter[] = ['all', 'unpaid', 'overdue'];

export function InvoiceList({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const items = useInvoices();
  const names = useClientNames();
  const today = todayIST();
  const [filter, setFilter] = useState<InvoiceFilter>('unpaid');
  const [q, setQ] = useState('');
  const shown = useMemo(() => filterInvoices(items, filter, today, q, names), [items, filter, today, q, names]);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.bill.invoices')} onBack={onBack} />
      <TextInput style={s.input} value={q} onChangeText={setQ} placeholder={t('m.bill.search')} placeholderTextColor={theme.textMuted}
        accessibilityLabel={t('common.search')} autoCorrect={false} autoCapitalize="none" />
      <View style={{ flexDirection: 'row', gap: 6, marginVertical: 8 }}>
        {FILTERS.map((f) => (
          <Pressable key={f} onPress={() => setFilter(f)} style={[s.chipBtn, filter === f && { backgroundColor: theme.primary, borderColor: theme.primary }]}
            accessibilityRole="button" accessibilityState={{ selected: filter === f }}>
            <Text style={{ color: filter === f ? theme.primaryText : theme.text }}>{t(`m.bill.filter.${f}`)}</Text>
          </Pressable>
        ))}
      </View>
      <FlatList data={shown} keyExtractor={(x) => x.id} initialNumToRender={20} keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.bill.noInvoices')}</Text>}
        renderItem={({ item }) => <InvoiceRow theme={theme} item={item} client={names.get(item.clientId)} today={today} onPress={() => nav.push({ name: 'invoice', id: item.id })} />} />
    </View>
  );
}

export function Collections({ theme, nav, onBack }: { theme: Theme; nav: Nav; onBack?: () => void }) {
  const s = ui(theme);
  const items = useInvoices();
  const names = useClientNames();
  const today = todayIST();
  const list = useMemo(() => collectionsToday(items, today), [items, today]);
  const total = list.reduce((a, i) => a + i.balancePaise, 0);
  return (
    <View style={{ flex: 1 }}>
      <Header theme={theme} title={t('m.bill.collections')} onBack={onBack} right={
        <Pressable style={s.ghost} onPress={() => nav.push({ name: 'invoices' })} accessibilityRole="button">
          <Feather name="file-text" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.bill.invoices')}</Text></Pressable>} />
      {!!list.length && <Text style={s.muted}>{t('m.bill.collectionsTotal', { count: list.length, amount: money(total) })}</Text>}
      <FlatList data={list} keyExtractor={(x) => x.id} initialNumToRender={20}
        ListEmptyComponent={<Text style={[s.muted, { marginTop: 24 }]}>{t('m.bill.noCollections')}</Text>}
        renderItem={({ item }) => <InvoiceRow theme={theme} item={item} client={names.get(item.clientId)} today={today} onPress={() => nav.push({ name: 'invoice', id: item.id })} />} />
    </View>
  );
}

export function ClientOutstanding({ theme, nav, clientId, onBack }: { theme: Theme; nav: Nav; clientId: string; onBack?: () => void }) {
  const s = ui(theme);
  const items = useInvoices();
  const receipts = useTable('receipt');
  const perms = useBillingPerms();
  const name = useClientNames().get(clientId) ?? '';
  const today = todayIST();
  const o = useMemo(() => clientOutstanding(items, receipts, clientId, today), [items, receipts, clientId, today]);
  const stat = (label: MessageKey, v: number, color?: string) => (
    <View style={{ flex: 1, minWidth: 140, padding: 10, borderRadius: 6, backgroundColor: theme.surfaceAlt }}>
      <Text style={s.muted}>{t(label)}</Text><Text style={[s.h1, color ? { color } : null]}>{money(v)}</Text>
    </View>
  );
  return (
    <FlatList data={o.open} keyExtractor={(x) => x.id}
      ListHeaderComponent={<View>
        <Header theme={theme} title={name || t('m.bill.outstanding')} onBack={onBack} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {stat('m.bill.outstanding', o.outstandingPaise)}
          {stat('m.bill.overdue', o.overduePaise, o.overduePaise ? theme.status.overdue : undefined)}
          {!!o.advancePaise && stat('m.bill.advance', o.advancePaise)}
          {!!o.advancePaise && stat('m.bill.net', o.netPaise)}
        </View>
        {perms.receipt && <Pressable style={s.button} onPress={() => nav.push({ name: 'receipt', clientId })} accessibilityRole="button">
          <Text style={s.buttonText}>{t('m.bill.record')}</Text></Pressable>}
        <Text style={s.h2}>{t('m.bill.openInvoices')}</Text>
        {!o.open.length && <Text style={s.muted}>{t('m.bill.noOpen')}</Text>}
      </View>}
      renderItem={({ item }) => <InvoiceRow theme={theme} item={item} today={today} client={name} onPress={() => nav.push({ name: 'invoice', id: item.id })} />} />
  );
}

export function InvoiceDetail({ theme, nav, id, onBack }: { theme: Theme; nav: Nav; id: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const perms = useBillingPerms();
  const item = useInvoices().find((i) => i.id === id);
  const client = useClientNames().get(item?.clientId ?? '');
  const [busy, setBusy] = useState(false);
  if (!item) return <View><Header theme={theme} title="" onBack={onBack} /><Text style={s.muted}>{t('m.bill.notFound')}</Text></View>;
  const today = todayIST();
  const days = isOverdue(item, today) ? daysOverdue(item, today) : 0;
  const needOnline = () => { if (!online) Alert.alert(t('m.bill.offlineAction')); return online; };
  const pdf = async () => {
    if (!needOnline()) return;
    setBusy(true);
    try { await openInvoicePdf(item.id, item.number ?? 'invoice'); } catch { Alert.alert(t('m.bill.pdfFailed')); } finally { setBusy(false); }
  };
  const share = async () => {
    if (!needOnline()) return;
    setBusy(true);
    try {
      const link = (await latestPaymentLink(item.id)) ?? (perms.link ? await createPaymentLink(item.id) : null);
      if (!link) { Alert.alert(t('m.bill.linkFailed')); return; }
      await Share.share({ message: t('m.bill.linkMessage', { number: item.number ?? '', amount: money(link.amountPaise), url: link.url }) });
    } catch { Alert.alert(t('m.bill.linkFailed')); } finally { setBusy(false); }
  };
  const line = (label: MessageKey, v: number) => (
    <View style={[s.row, { minHeight: 40 }]}><Text style={[s.muted, { flex: 1 }]}>{t(label)}</Text><Text style={s.text}>{money(v)}</Text></View>
  );
  return (
    <View>
      <Header theme={theme} title={item.number ?? '—'} onBack={onBack} right={<Text style={s.chip}>{t(statusKey(item))}</Text>} />
      <Pressable onPress={() => nav.push({ name: 'outstanding', clientId: item.clientId })} accessibilityRole="link">
        <Text style={[s.text, { color: theme.primary }]}>{client ?? item.billToName}</Text></Pressable>
      <Text style={s.muted}>{[item.issueDate && t('m.bill.issued', { date: item.issueDate }), item.dueDate ? t('m.bill.dueOn', { date: item.dueDate }) : t('m.bill.noDue')].filter(Boolean).join(' · ')}</Text>
      {!!days && <Text style={[s.alert, { color: theme.status.overdue }]}>{t('m.bill.overdueDays', { days })}</Text>}
      {!!item.promiseToPay && <Text style={s.muted}>{t('m.bill.promise', { date: item.promiseToPay })}</Text>}
      <View style={{ marginTop: 12 }}>
        {line('m.bill.total', item.totalPaise)}
        {!!item.allocatedPaise && line('m.bill.paid', item.allocatedPaise)}
        {!!item.tdsPaise && line('m.bill.tds', item.tdsPaise)}
        {!!item.creditedPaise && line('m.bill.credited', item.creditedPaise)}
        {line('m.bill.balance', item.balancePaise)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12, opacity: busy ? 0.5 : 1 }}>
        {perms.print && item.number && <Pressable style={s.ghost} disabled={busy} onPress={() => void pdf()} accessibilityRole="button">
          <Feather name="file" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.bill.pdf')}</Text></Pressable>}
        {perms.view && isOpen(item) && <Pressable style={s.ghost} disabled={busy} onPress={() => void share()} accessibilityRole="button">
          <Feather name="share-2" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.bill.shareLink')}</Text></Pressable>}
        {perms.receipt && isOpen(item) && <Pressable style={s.ghost} onPress={() => nav.push({ name: 'receipt', clientId: item.clientId })} accessibilityRole="button">
          <Feather name="dollar-sign" size={16} color={theme.primary} /><Text style={s.ghostText}>{t('m.bill.record')}</Text></Pressable>}
      </View>
    </View>
  );
}

const errKey = (e: ReceiptError): MessageKey => `m.bill.err.${e}`;

export function RecordReceipt({ theme, clientId, onBack }: { theme: Theme; clientId: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const items = useInvoices();
  const numbers = useMemo(() => new Map(items.map((i) => [i.id, i.number ?? i.id])), [items]);
  const open = useMemo(() => items.filter((i) => i.clientId === clientId && isOpen(i)), [items, clientId]);
  const name = useClientNames().get(clientId) ?? '';
  const [f, setF] = useState<ReceiptForm>({ amount: '', tds: '', tdsSection: '', mode: 'upi', reference: '', receivedOn: todayIST() });
  const [errors, setErrors] = useState<ReceiptError[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ number: string; allocations: Array<{ invoiceId: string; amountPaise: number; tdsPaise?: number }> } | null>(null);
  const built = buildReceipt(clientId, f);
  const preview = built.ok ? allocationPreview(open, built.body.amountPaise, built.body.tdsPaise) : null;
  const set = (k: keyof ReceiptForm) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    if (!online) { Alert.alert(t('m.bill.offlineReceipt')); return; }
    if (!built.ok) { setErrors(built.errors); return; }
    setErrors([]); setBusy(true);
    try { setResult(await recordReceipt(built.body)); }
    catch (e) { Alert.alert(t('m.bill.recordFailed', { reason: (e as Error).message })); }
    finally { setBusy(false); }
  };
  const allocRow = (a: { invoiceId: string; amountPaise: number; tdsPaise?: number }) => (
    <View key={a.invoiceId} style={[s.row, { minHeight: 40 }]}>
      <Text style={[s.text, { flex: 1 }]}>{numbers.get(a.invoiceId) ?? a.invoiceId}</Text>
      <Text style={s.text}>{money(a.amountPaise)}{a.tdsPaise ? ` + ${t('m.bill.tds')} ${money(a.tdsPaise)}` : ''}</Text>
    </View>
  );
  if (result) return (
    <View>
      <Header theme={theme} title={t('m.bill.recorded', { number: result.number })} onBack={onBack} />
      <Text style={s.h2}>{t('m.bill.serverAllocation')}</Text>
      {result.allocations.map(allocRow)}
      <Pressable style={s.button} onPress={onBack} accessibilityRole="button"><Text style={s.buttonText}>{t('common.close')}</Text></Pressable>
    </View>
  );
  return (
    <View>
      <Header theme={theme} title={t('m.bill.record')} onBack={onBack} />
      <Text style={s.muted}>{name}</Text>
      {!online && <Text accessibilityRole="alert" style={s.alert}>{t('m.bill.offlineReceipt')}</Text>}
      {errors.map((e) => <Text key={e} accessibilityRole="alert" style={[s.alert, { color: theme.status.overdue }]}>{t(errKey(e))}</Text>)}
      <Text style={s.label}>{t('m.bill.amount')}</Text>
      <TextInput style={s.input} value={f.amount} onChangeText={set('amount')} keyboardType="decimal-pad" accessibilityLabel={t('m.bill.amount')} />
      <Text style={s.label}>{t('m.bill.mode')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {RECEIPT_MODES.map((m) => (
          <Pressable key={m} onPress={() => set('mode')(m)} style={[s.chipBtn, f.mode === m && { backgroundColor: theme.primary, borderColor: theme.primary }]}
            accessibilityRole="button" accessibilityState={{ selected: f.mode === m }}>
            <Text style={{ color: f.mode === m ? theme.primaryText : theme.text }}>{t(`m.bill.mode.${m}`)}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.label}>{t('m.bill.reference')}</Text>
      <TextInput style={s.input} value={f.reference} onChangeText={set('reference')} accessibilityLabel={t('m.bill.reference')} />
      <Text style={s.label}>{t('m.bill.tdsAmount')}</Text>
      <TextInput style={s.input} value={f.tds} onChangeText={set('tds')} keyboardType="decimal-pad" accessibilityLabel={t('m.bill.tdsAmount')} />
      <Text style={s.label}>{t('m.bill.tdsSection')}</Text>
      <TextInput style={s.input} value={f.tdsSection} onChangeText={set('tdsSection')} autoCapitalize="characters" accessibilityLabel={t('m.bill.tdsSection')} />
      <Text style={s.label}>{t('m.bill.receivedOn')}</Text>
      <TextInput style={s.input} value={f.receivedOn} onChangeText={set('receivedOn')} accessibilityLabel={t('m.bill.receivedOn')} />
      {preview && (preview.allocations.length > 0 || preview.advancePaise > 0) && <View>
        <Text style={s.h2}>{t('m.bill.preview')}</Text>
        {preview.allocations.map(allocRow)}
        {!!preview.advancePaise && <Text style={s.muted}>{t('m.bill.toAdvance', { amount: money(preview.advancePaise) })}</Text>}
      </View>}
      <Pressable style={[s.button, (busy || !online) && { opacity: 0.5 }]} disabled={busy} onPress={() => void submit()} accessibilityRole="button">
        <Text style={s.buttonText}>{busy ? t('m.bill.saving') : t('m.bill.save')}</Text>
      </Pressable>
    </View>
  );
}
