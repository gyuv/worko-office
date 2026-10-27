// Worko service worker: shows Web Push notifications and focuses the app on click.
self.addEventListener('push', (event) => {
  let n = {};
  try { n = event.data ? event.data.json() : {}; } catch { n = { title: 'Worko', body: event.data && event.data.text() }; }
  const urgent = n.priority === 'critical' || n.priority === 'high';
  event.waitUntil(self.registration.showNotification(n.title || 'Worko', {
    body: n.body || '', tag: n.id, renotify: false, requireInteraction: n.priority === 'critical',
    data: { id: n.id }, silent: !urgent,
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = all[0];
    if (target) { await target.focus(); target.navigate && target.navigate('./#/notifications'); }
    else await self.clients.openWindow('./#/notifications');
  })());
});
