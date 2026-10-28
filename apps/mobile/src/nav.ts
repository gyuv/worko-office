import type { MessageKey } from '@worko/i18n';

/** Bottom navigation per spec §13: Home / Tasks / Clients / Inbox / More. Icons are Feather names. */
export type Tab = 'home' | 'tasks' | 'clients' | 'inbox' | 'more';
export const TABS: Array<{ key: Tab; label: MessageKey; icon: 'home' | 'check-square' | 'briefcase' | 'inbox' | 'menu'; phase?: number }> = [
  { key: 'home', label: 'nav.home', icon: 'home' },
  { key: 'tasks', label: 'nav.tasks', icon: 'check-square' },
  { key: 'clients', label: 'nav.clients', icon: 'briefcase', phase: 3 },
  { key: 'inbox', label: 'nav.inbox', icon: 'inbox', phase: 2 },
  { key: 'more', label: 'nav.more', icon: 'menu' },
];
