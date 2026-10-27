import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { LocalReminder } from '@worko/notify';
import { CHANNELS, channelFor } from './channels';
import { api } from './session';

const importance = { max: Notifications.AndroidImportance.MAX, high: Notifications.AndroidImportance.HIGH, default: Notifications.AndroidImportance.DEFAULT, low: Notifications.AndroidImportance.LOW };

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true }),
});

/** Channels + permission + (when Firebase is configured) FCM token registration with the API. */
export async function setupNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    for (const c of CHANNELS) await Notifications.setNotificationChannelAsync(c.id, { name: c.name, importance: importance[c.importance] });
  }
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted' || !Device.isDevice) return false;
  try {
    // Requires google-services.json (Firebase) in the native build — VERIFY when FCM credentials exist.
    const token = await Notifications.getDevicePushTokenAsync();
    await api.POST('/push/subscriptions', { body: { kind: 'fcm', endpoint: String(token.data) } });
  } catch { /* no Firebase config yet: local reminders still work */ }
  return true;
}

export async function cancelAllScheduled() { await Notifications.cancelAllScheduledNotificationsAsync(); }

/** Replaces the OS schedule with the given reminders (exact alarms; survive reboot). */
export async function scheduleUpcoming(items: Array<{ reminder: LocalReminder; at: number }>) {
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const { reminder: r, at } of items.slice(0, 60)) { // stay well under Android's per-app alarm limits
    await Notifications.scheduleNotificationAsync({
      identifier: r.id,
      content: { title: r.title, body: r.body, data: { id: r.id }, priority: r.priority === 'critical' ? 'max' : 'high' },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at), channelId: channelFor(r.category, r.priority) },
    });
  }
}
