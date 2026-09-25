// Service worker — notifications ONLY. It deliberately has no `fetch` handler.
//
// Caching here would be actively harmful: the app already fights stale chunks after a deploy
// (see the vite:preloadError guard in main.tsx), and a caching SW is exactly how a tab ends up
// holding an index.html whose chunks no longer exist. This worker exists for one reason —
// Android Chrome refuses `new Notification()` and will only show a notification through a
// registration, so we need a registration to exist.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// Clicking the banner should land you in the app you already have open, not in a second copy.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of all) {
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow('/')
    })(),
  )
})
