import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { isTablet } from '../logic/layout';
import type { RegisterKind } from '../logic/registers';
import type { Theme } from '../theme';
import { t, ui } from '../ui';
import { ClientOutstanding, Collections, InvoiceDetail, InvoiceList, RecordReceipt } from './Billing';
import { ClientDetail, ClientList } from './Clients';
import { DocUpload } from './DocUpload';
import { EntryDetail, RegisterForm, RegisterList } from './Registers';
import { Approvals, Attendance, ExpenseForm, Expenses, HrHub, Leave, LeaveApply, MyTime, TimeEntryForm, Timer } from './Hr';
import { Appointments, Calendar, ChatList, ChatThread, ClientTimeline, EventForm } from './Comm';
import { LeadBoard, LeadDetail } from './Leads';
import { Compliance, TaskDetail, TaskList, Todos } from './Tasks';
import { AuditList, DscDetail, DscList, EngagementDetail, EsignDetail, EsignList, Hearings, NoticeDetail, NoticeList, NoticeScan, PracticeHub } from './Practice';

export type Route =
  | { name: 'clients' } | { name: 'client'; id: string } | { name: 'upload'; clientId: string }
  | { name: 'registers'; clientId?: string } | { name: 'regForm'; kind: RegisterKind; clientId?: string } | { name: 'entry'; kind: RegisterKind; id: string }
  | { name: 'tasks' } | { name: 'task'; id: string } | { name: 'todos' } | { name: 'compliance' }
  | { name: 'collections' } | { name: 'invoices' } | { name: 'invoice'; id: string } | { name: 'outstanding'; clientId: string } | { name: 'receipt'; clientId: string }
  | { name: 'hr' } | { name: 'timer' } | { name: 'myTime' } | { name: 'timeEntry'; id?: string } | { name: 'attendance' } | { name: 'leave' } | { name: 'leaveApply' }
  | { name: 'expenses' } | { name: 'expenseForm' } | { name: 'approvals' }
  | { name: 'chat' } | { name: 'chatThread'; id: string } | { name: 'calendar' } | { name: 'eventForm'; id?: string; date?: string } | { name: 'timeline'; clientId: string } | { name: 'appointments' }
  | { name: 'practice' } | { name: 'notices' } | { name: 'notice'; id: string } | { name: 'noticeScan'; clientId?: string; noticeId?: string } | { name: 'hearings' }
  | { name: 'dscList' } | { name: 'dsc'; id: string } | { name: 'audit' } | { name: 'engagement'; id: string } | { name: 'esignList' } | { name: 'esign'; id: string }
  | { name: 'leads' } | { name: 'lead'; id: string };
export type Nav = { push(r: Route): void; pop(): void; replace(r: Route): void; reset(r?: Route): void };

/** A tiny stack (no navigation library). On tablets the root list stays on the left and the top route shows on the right. */
export function Stack({ theme, root }: { theme: Theme; root: Route }) {
  const [stack, setStack] = useState<Route[]>([root]);
  const nav: Nav = {
    push: (r) => setStack((s) => [...s, r]),
    pop: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
    reset: (r) => setStack(r ? [root, r] : [root]),
  };
  const depth = stack.length;
  const onBack = useCallback(() => { if (depth > 1) { setStack((s) => s.slice(0, -1)); return true; } return false; }, [depth]);
  useEffect(() => { const sub = BackHandler.addEventListener('hardwareBackPress', onBack); return () => sub.remove(); }, [onBack]);
  const tablet = isTablet(useWindowDimensions().width);
  const top = stack[depth - 1]!;
  if (tablet) {
    // Selecting from the left list replaces the right pane rather than growing the stack.
    const leftNav: Nav = { ...nav, push: (r) => nav.reset(r) };
    return (
      <View style={{ flex: 1, flexDirection: 'row', gap: 16 }}>
        <View style={{ width: 360, borderRightWidth: 1, borderColor: theme.border, paddingRight: 12 }}>{render(root, leftNav, theme, true)}</View>
        <View style={{ flex: 1 }}>{depth > 1 ? render(top, nav, theme, false) : render({ name: 'clients' }, nav, theme, false, true)}</View>
      </View>
    );
  }
  return <View style={{ flex: 1 }}>{render(top, nav, theme, depth === 1)}</View>;
}

function render(r: Route, nav: Nav, theme: Theme, isRoot: boolean, placeholder = false) {
  const back = isRoot ? undefined : nav.pop;
  const scroll = (el: React.ReactNode) => <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>{el}</ScrollView>;
  if (placeholder) return <Text style={[ui(theme).muted, { marginTop: 24, textAlign: 'center' }]}>{t('m.clients.select')}</Text>;
  switch (r.name) {
    case 'clients': return <ClientList theme={theme} nav={nav} />;
    case 'client': return <ClientDetail key={r.id} theme={theme} nav={nav} id={r.id} onBack={back} />;
    case 'upload': return scroll(<DocUpload theme={theme} clientId={r.clientId} onBack={back} />);
    case 'registers': return <RegisterList theme={theme} nav={nav} clientId={r.clientId} onBack={back} />;
    case 'regForm': return scroll(<RegisterForm theme={theme} nav={nav} kind={r.kind} clientId={r.clientId} onBack={back} />);
    case 'entry': return scroll(<EntryDetail key={r.id} theme={theme} kind={r.kind} id={r.id} onBack={back} />);
    case 'tasks': return <TaskList theme={theme} nav={nav} />;
    case 'task': return scroll(<TaskDetail key={r.id} theme={theme} id={r.id} onBack={back} />);
    case 'todos': return <Todos theme={theme} onBack={back} />;
    case 'compliance': return <Compliance theme={theme} nav={nav} onBack={back} />;
    case 'collections': return <Collections theme={theme} nav={nav} onBack={back} />;
    case 'invoices': return <InvoiceList theme={theme} nav={nav} onBack={back} />;
    case 'invoice': return scroll(<InvoiceDetail key={r.id} theme={theme} nav={nav} id={r.id} onBack={back} />);
    case 'outstanding': return <ClientOutstanding key={r.clientId} theme={theme} nav={nav} clientId={r.clientId} onBack={back} />;
    case 'receipt': return scroll(<RecordReceipt key={r.clientId} theme={theme} clientId={r.clientId} onBack={back} />);
    case 'hr': return <HrHub theme={theme} nav={nav} onBack={back} />;
    case 'timer': return scroll(<Timer theme={theme} nav={nav} onBack={back} />);
    case 'myTime': return <MyTime theme={theme} nav={nav} onBack={back} />;
    case 'timeEntry': return scroll(<TimeEntryForm key={r.id ?? 'new'} theme={theme} nav={nav} id={r.id} onBack={back} />);
    case 'attendance': return <Attendance theme={theme} onBack={back} />;
    case 'leave': return <Leave theme={theme} nav={nav} onBack={back} />;
    case 'leaveApply': return scroll(<LeaveApply theme={theme} nav={nav} onBack={back} />);
    case 'expenses': return <Expenses theme={theme} nav={nav} onBack={back} />;
    case 'expenseForm': return scroll(<ExpenseForm theme={theme} nav={nav} onBack={back} />);
    case 'approvals': return <Approvals theme={theme} onBack={back} />;
    case 'chat': return <ChatList theme={theme} nav={nav} onBack={back} />;
    case 'chatThread': return <ChatThread key={r.id} theme={theme} id={r.id} onBack={back} />;
    case 'calendar': return <Calendar theme={theme} nav={nav} onBack={back} />;
    case 'eventForm': return scroll(<EventForm key={r.id ?? 'new'} theme={theme} nav={nav} id={r.id} date={r.date} onBack={back} />);
    case 'timeline': return <ClientTimeline key={r.clientId} theme={theme} clientId={r.clientId} onBack={back} />;
    case 'appointments': return <Appointments theme={theme} onBack={back} />;
    case 'practice': return scroll(<PracticeHub theme={theme} nav={nav} onBack={back} />);
    case 'notices': return <NoticeList theme={theme} nav={nav} onBack={back} />;
    case 'notice': return scroll(<NoticeDetail key={r.id} theme={theme} nav={nav} id={r.id} onBack={back} />);
    case 'noticeScan': return scroll(<NoticeScan key={r.noticeId ?? r.clientId ?? 'new'} theme={theme} nav={nav} clientId={r.clientId} noticeId={r.noticeId} onBack={back} />);
    case 'hearings': return <Hearings theme={theme} nav={nav} onBack={back} />;
    case 'dscList': return <DscList theme={theme} nav={nav} onBack={back} />;
    case 'dsc': return scroll(<DscDetail key={r.id} theme={theme} id={r.id} onBack={back} />);
    case 'audit': return <AuditList theme={theme} nav={nav} onBack={back} />;
    case 'engagement': return scroll(<EngagementDetail key={r.id} theme={theme} id={r.id} onBack={back} />);
    case 'esignList': return <EsignList theme={theme} nav={nav} onBack={back} />;
    case 'esign': return scroll(<EsignDetail key={r.id} theme={theme} id={r.id} onBack={back} />);
    case 'leads': return <LeadBoard theme={theme} nav={nav} onBack={back} />;
    case 'lead': return scroll(<LeadDetail key={r.id} theme={theme} id={r.id} onBack={back} />);
  }
}
