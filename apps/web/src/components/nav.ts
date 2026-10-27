import type { MessageKey } from '@worko/i18n';
import type { Action, Module } from '@worko/domain';
import { BarChart3, Bell, Briefcase, CalendarCheck, FileText, Home, IndianRupee, ScrollText, Shield, Users, CheckSquare, type LucideIcon } from 'lucide-react';
import type { Route } from '../lib/router';

export type NavItem = { route: Route; label: MessageKey; icon: LucideIcon; phase?: number; perm?: [Module, Action]; shortcut?: string };

export const NAV: NavItem[] = [
  { route: 'home', label: 'nav.home', icon: Home, shortcut: 'g h' },
  { route: 'tasks', label: 'nav.tasks', icon: CheckSquare, phase: 4, shortcut: 'g t' },
  { route: 'clients', label: 'nav.clients', icon: Briefcase, phase: 3, shortcut: 'g c' },
  { route: 'compliance', label: 'nav.compliance', icon: CalendarCheck, phase: 4 },
  { route: 'billing', label: 'nav.billing', icon: IndianRupee, phase: 5, perm: ['billing', 'view'] },
  { route: 'documents', label: 'nav.documents', icon: FileText, phase: 3 },
  { route: 'reports', label: 'nav.reports', icon: BarChart3, phase: 11 },
  { route: 'notifications', label: 'nav.notifications', icon: Bell, shortcut: 'g n' },
  { route: 'team', label: 'nav.team', icon: Users, perm: ['users', 'view'] },
  { route: 'security', label: 'nav.security', icon: Shield },
  { route: 'audit', label: 'nav.audit', icon: ScrollText, perm: ['audit_log', 'view'] },
];
