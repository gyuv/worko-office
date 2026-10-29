import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { LoginScreen } from '../auth/LoginScreen';
import { NAV } from '../components/nav';
import { Shell } from '../components/Shell';
import { I18nProvider, useT } from '../lib/i18n';
import { useRoute } from '../lib/router';
import { api, useSession } from '../lib/session';
import { AuditScreen } from '../screens/AuditScreen';
import { ComingSoon, HomeScreen } from '../screens/HomeScreen';
import { SecurityScreen } from '../screens/SecurityScreen';
import { TeamScreen } from '../screens/TeamScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { startSync, stopSync } from '../lib/sync';
import { ClientsRoute } from '../screens/clients/ClientsScreen';
import { DocumentsScreen } from '../screens/documents/DocumentsScreen';
import { RegistersScreen } from '../screens/registers/RegistersScreen';
import { ComplianceScreen } from '../screens/compliance/ComplianceScreen';
import { BillingRoute } from '../screens/billing/BillingScreen';
import { SettingsRoute } from '../screens/billing/BillingSettings';
import { ReceiptsScreen } from '../screens/billing/ReceiptsScreen';
import { TasksScreen } from '../screens/tasks/TasksScreen';
import { TodosScreen } from '../screens/todos/TodosScreen';
import { ToastHost } from '../components/Toast';
import { TimeScreen } from '../screens/time/TimeScreen';
import { ReportsScreen } from '../screens/reports/ReportsScreen';
import { AttendanceScreen } from '../screens/hr/AttendanceScreen';
import { LeaveScreen } from '../screens/hr/LeaveScreen';
import { ExpensesScreen } from '../screens/hr/ExpensesScreen';
import { CommScreen } from '../screens/comm/CommScreen';
import { ChatScreen } from '../screens/comm/ChatScreen';
import { CalendarScreen } from '../screens/comm/CalendarScreen';
import { BookingScreen } from '../screens/comm/BookingScreen';
import { ManageBooking, PublicBook } from '../screens/comm/PublicBooking';
import { publicRoute } from '../screens/comm/logic';
import { NoticesScreen } from '../screens/practice/NoticesScreen';
import { AuditWorkScreen } from '../screens/practice/AuditWorkScreen';
import { DscScreen, LicencesScreen } from '../screens/practice/DscScreen';
import { EsignScreen, PublicEsign } from '../screens/practice/EsignScreen';
import { esignPublicToken } from '../screens/practice/logic';
import { LeadsRoute } from '../screens/leads/LeadsScreen';
import { PublicProposal } from '../screens/leads/PublicProposal';
import { proposalPublicToken } from '../screens/leads/logic';
import { AutomationScreen } from '../screens/automation/AutomationScreen';
import { SuggestionsScreen } from '../screens/ai/SuggestionsScreen';
import { PortalRoot } from '../portal/PortalApp';
import { parsePortalHash } from '../portal/logic';

function Routes() {
  const t = useT();
  const route = useRoute((s) => s.route);
  switch (route) {
    case 'home': return <HomeScreen />;
    case 'security': return <SecurityScreen />;
    case 'audit': return <AuditScreen />;
    case 'team': return <TeamScreen />;
    case 'notifications': return <NotificationsScreen />;
    case 'clients': return <ClientsRoute />;
    case 'documents': return <DocumentsScreen />;
    case 'registers': return <RegistersScreen />;
    case 'tasks': return <TasksScreen />;
    case 'compliance': return <ComplianceScreen />;
    case 'todos': return <TodosScreen />;
    case 'settings': return <SettingsRoute />;
    case 'billing': return <BillingRoute />;
    case 'receipts': return <ReceiptsScreen />;
    case 'time': return <TimeScreen />;
    case 'attendance': return <AttendanceScreen />;
    case 'leave': return <LeaveScreen />;
    case 'expenses': return <ExpensesScreen />;
    case 'reports': return <ReportsScreen />;
    case 'comm': return <CommScreen />;
    case 'chat': return <ChatScreen />;
    case 'calendar': return <CalendarScreen />;
    case 'booking': return <BookingScreen />;
    case 'notices': return <NoticesScreen />;
    case 'engagements': return <AuditWorkScreen />;
    case 'dsc': return <DscScreen />;
    case 'licences': return <LicencesScreen />;
    case 'esign': return <EsignScreen />;
    case 'leads': return <LeadsRoute />;
    case 'automation': return <AutomationScreen />;
    case 'suggestions': return <SuggestionsScreen />;
    default: {
      const n = NAV.find((x) => x.route === route)!;
      return <ComingSoon module={t(n.label)} phase={n.phase ?? 0} />;
    }
  }
}

type PublicR = ReturnType<typeof publicRoute> | { kind: 'esign'; token: string } | { kind: 'proposal'; token: string };

/** Public booking + e-sign signer pages (no login), decided from the hash (or path) before any session logic. */
function usePublicRoute() {
  const read = (): PublicR => {
    if (typeof location === 'undefined') return null;
    const token = esignPublicToken(location.hash, location.pathname);
    if (token) return { kind: 'esign', token };
    const prop = proposalPublicToken(location.hash, location.pathname);
    return prop ? { kind: 'proposal', token: prop } : publicRoute(location.hash, location.pathname);
  };
  const [r, setR] = useState(read);
  useEffect(() => { const on = () => setR(read()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  return r;
}

function PublicApp({ r }: { r: NonNullable<PublicR> }) {
  const qc = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }), []);
  const firm = typeof location !== 'undefined' ? new URLSearchParams(location.hash.split('?')[1] ?? '').get('firm') ?? undefined : undefined;
  return (
    <I18nProvider>
      <QueryClientProvider client={qc}>
        {r.kind === 'proposal' ? <PublicProposal key={r.token} token={r.token} /> : r.kind === 'esign' ? <PublicEsign key={r.token} token={r.token} /> : r.kind === 'book' ? <PublicBook key={`${r.firm}/${r.slug}`} firm={r.firm} slug={r.slug} /> : <ManageBooking key={r.token} token={r.token} firmSlug={firm} />}
      </QueryClientProvider>
    </I18nProvider>
  );
}

/** Client portal (`#/portal/{firm}/…`): its own tokens/http client; never touches the staff session. */
function usePortalRoute() {
  const read = () => (typeof location === 'undefined' ? null : parsePortalHash(location.hash));
  const [r, setR] = useState(read);
  useEffect(() => { const on = () => setR(read()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  return r;
}

export function App() {
  const portal = usePortalRoute();
  const pub = usePublicRoute();
  return portal ? <PortalRoot loc={portal} /> : pub ? <PublicApp r={pub} /> : <StaffApp />;
}

function StaffApp() {
  const { tokens, ready, init, setTokens } = useSession();
  const qc = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }), []);
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { if (!tokens) qc.clear(); }, [tokens, qc]);
  // Sync runs per signed-in session (not per token refresh); it stops, keeping data, if tokens disappear by expiry.
  const sessionKey = tokens ? `${tokens.tenantId}:${tokens.userId}:${tokens.sessionId}` : '';
  useEffect(() => {
    if (sessionKey) { const [tenantId, userId, sessionId] = sessionKey.split(':') as [string, string, string]; void startSync(tenantId, userId, sessionId); }
    else void stopSync(false);
  }, [sessionKey]);

  // Explicit sign-out erases the local copy (shared office PCs).
  const signOut = async () => { await api.POST('/auth/logout').catch(() => undefined); await stopSync(true); setTokens(null); };

  if (!ready) return null;
  return (
    <I18nProvider>
      <QueryClientProvider client={qc}>
        {tokens ? <Shell onSignOut={signOut}><Routes /><ToastHost /></Shell> : <LoginScreen />}
      </QueryClientProvider>
    </I18nProvider>
  );
}
