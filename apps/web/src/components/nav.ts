import type { MessageKey } from '@worko/i18n';
import type { Action, Module } from '@worko/domain';
import { BarChart3, Bell, Clock, Fingerprint, Plane, Receipt, Briefcase, CalendarCheck, FileText, Home, IndianRupee, ScrollText, Shield, Users, CheckSquare, ArrowLeftRight, ListTodo, Settings, Wallet, Megaphone, MessagesSquare, CalendarDays, CalendarClock, Gavel, ClipboardCheck, KeyRound, BadgeCheck, PenTool, Target, Workflow, Sparkles, type LucideIcon } from 'lucide-react';
import type { Route } from '../lib/router';

export type NavItem = { route: Route; label: MessageKey; icon: LucideIcon; phase?: number; perm?: [Module, Action]; shortcut?: string };

export const NAV: NavItem[] = [
  { route: 'home', label: 'nav.home', icon: Home, shortcut: 'g h' },
  { route: 'tasks', label: 'nav.tasks', icon: CheckSquare, perm: ['tasks', 'view'], shortcut: 'g t' },
  { route: 'todos', label: 'nav.todos', icon: ListTodo },
  { route: 'clients', label: 'nav.clients', icon: Briefcase, shortcut: 'g c' },
  { route: 'leads', label: 'p9.nav.leads', icon: Target, perm: ['leads', 'view'] },
  { route: 'compliance', label: 'nav.compliance', icon: CalendarCheck, perm: ['compliance', 'view'] },
  { route: 'billing', label: 'nav.billing', icon: IndianRupee, perm: ['billing', 'view'] },
  { route: 'receipts', label: 'nav.receipts', icon: Wallet, perm: ['receipts', 'view'] },
  { route: 'notices', label: 'p8.nav.notices', icon: Gavel, perm: ['notices', 'view'] },
  { route: 'engagements', label: 'p8.nav.engagements', icon: ClipboardCheck, perm: ['audit', 'view'] },
  { route: 'dsc', label: 'p8.nav.dsc', icon: KeyRound, perm: ['dsc', 'view'] },
  { route: 'licences', label: 'p8.nav.licences', icon: BadgeCheck, perm: ['compliance', 'view'] },
  { route: 'esign', label: 'p8.nav.esign', icon: PenTool, perm: ['documents', 'view'] },
  { route: 'documents', label: 'nav.documents', icon: FileText, shortcut: 'g d' },
  { route: 'registers', label: 'nav.registers', icon: ArrowLeftRight, perm: ['registers', 'view'], shortcut: 'g r' },
  { route: 'time', label: 'p6.nav.time', icon: Clock, perm: ['time', 'view'] },
  { route: 'attendance', label: 'p6.nav.attendance', icon: Fingerprint, perm: ['hr', 'view'] },
  { route: 'leave', label: 'p6.nav.leave', icon: Plane, perm: ['hr', 'view'] },
  { route: 'expenses', label: 'p6.nav.expenses', icon: Receipt, perm: ['hr', 'view'] },
  { route: 'comm', label: 'p7.nav.comm', icon: Megaphone, perm: ['communication', 'view'] },
  { route: 'chat', label: 'p7.nav.chat', icon: MessagesSquare },
  { route: 'calendar', label: 'p7.nav.calendar', icon: CalendarDays },
  { route: 'booking', label: 'p7.nav.booking', icon: CalendarClock, perm: ['communication', 'view'] },
  { route: 'automation', label: 'p10.nav.automation', icon: Workflow, perm: ['automation', 'view'] },
  { route: 'suggestions', label: 'p10.nav.suggestions', icon: Sparkles, perm: ['ai', 'view'] },
  { route: 'reports', label: 'nav.reports', icon: BarChart3 },
  { route: 'notifications', label: 'nav.notifications', icon: Bell, shortcut: 'g n' },
  { route: 'team', label: 'nav.team', icon: Users, perm: ['users', 'view'] },
  { route: 'security', label: 'nav.security', icon: Shield },
  { route: 'settings', label: 'nav.settings', icon: Settings, perm: ['settings', 'view'] },
  { route: 'audit', label: 'nav.audit', icon: ScrollText, perm: ['audit_log', 'view'] },
];
