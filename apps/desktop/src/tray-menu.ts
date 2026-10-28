export type MenuItem = { label?: string; type?: 'separator' | 'checkbox'; checked?: boolean; click?: () => void; enabled?: boolean };

export function trayMenu(o: { badge: number; autoStart: boolean; open(): void; toggleAutoStart(): void; quit(): void }): MenuItem[] {
  return [
    { label: o.badge > 0 ? `Open Worko (${o.badge} pending)` : 'Open Worko', click: o.open },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: o.autoStart, click: o.toggleAutoStart },
    { type: 'separator' },
    { label: 'Quit Worko', click: o.quit },
  ];
}
