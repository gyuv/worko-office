/**
 * Android notification channels, one per category group, so users can mute e.g. "Billing" in system settings
 * without losing "Compliance & notices" (spec §7). Pure mapping — testable without Expo.
 */
export type ChannelDef = { id: string; name: string; importance: 'max' | 'high' | 'default' | 'low' };

export const CHANNELS: ChannelDef[] = [
  { id: 'critical', name: 'Critical alerts', importance: 'max' },
  { id: 'compliance', name: 'Compliance & notices', importance: 'high' },
  { id: 'tasks', name: 'Tasks', importance: 'high' },
  { id: 'billing', name: 'Billing & payments', importance: 'default' },
  { id: 'registers', name: 'DSC, licences & documents', importance: 'default' },
  { id: 'team', name: 'Team & approvals', importance: 'default' },
  { id: 'system', name: 'System', importance: 'low' },
];

export function channelFor(category: string, priority: string): string {
  if (priority === 'critical') return 'critical';
  const [group] = category.split('.');
  switch (group) {
    case 'compliance': case 'notice': return 'compliance';
    case 'task': return 'tasks';
    case 'invoice': case 'payment': return 'billing';
    case 'dsc': case 'licence': case 'document': case 'client': return 'registers';
    case 'leave': case 'attendance': case 'whatsapp': case 'automation': case 'chat': case 'comm': case 'broadcast': case 'appointment': return 'team';
    default: return 'system';
  }
}
