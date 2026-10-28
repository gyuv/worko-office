import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { isTablet } from '../logic/layout';
import type { RegisterKind } from '../logic/registers';
import type { Theme } from '../theme';
import { t, ui } from '../ui';
import { ClientDetail, ClientList } from './Clients';
import { DocUpload } from './DocUpload';
import { EntryDetail, RegisterForm, RegisterList } from './Registers';
import { Compliance, TaskDetail, TaskList, Todos } from './Tasks';

export type Route =
  | { name: 'clients' } | { name: 'client'; id: string } | { name: 'upload'; clientId: string }
  | { name: 'registers'; clientId?: string } | { name: 'regForm'; kind: RegisterKind; clientId?: string } | { name: 'entry'; kind: RegisterKind; id: string }
  | { name: 'tasks' } | { name: 'task'; id: string } | { name: 'todos' } | { name: 'compliance' };
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
  }
}
