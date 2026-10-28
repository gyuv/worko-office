import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
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
import { ServicesSettings } from '../screens/settings/ServicesSettings';
import { TasksScreen } from '../screens/tasks/TasksScreen';
import { TodosScreen } from '../screens/todos/TodosScreen';
import { ToastHost } from '../components/Toast';

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
    case 'settings': return <ServicesSettings />;
    default: {
      const n = NAV.find((x) => x.route === route)!;
      return <ComingSoon module={t(n.label)} phase={n.phase ?? 0} />;
    }
  }
}

export function App() {
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
