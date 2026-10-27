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

function Routes() {
  const t = useT();
  const route = useRoute((s) => s.route);
  switch (route) {
    case 'home': return <HomeScreen />;
    case 'security': return <SecurityScreen />;
    case 'audit': return <AuditScreen />;
    case 'team': return <TeamScreen />;
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

  const signOut = async () => { await api.POST('/auth/logout').catch(() => undefined); setTokens(null); };

  if (!ready) return null;
  return (
    <I18nProvider>
      <QueryClientProvider client={qc}>
        {tokens ? <Shell onSignOut={signOut}><Routes /></Shell> : <LoginScreen />}
      </QueryClientProvider>
    </I18nProvider>
  );
}
