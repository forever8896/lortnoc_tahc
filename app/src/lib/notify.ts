// Notifications — the "someone reached you" signal for native DM (§6.6) and knocks (§6.8).
//
// Honest limit, stated once so nobody mistakes this for push: NOTHING WAKES A CLOSED TAB. The app
// polls (§6.4 — Walrus is a durable log, not a bus), so a notification here means "a poll in an
// open tab found something new". There is no push subscription and no server that could send one:
// the relayer never learns a message exists, and a knock is an opaque blob it cannot read. For
// device-to-device, the receiving side keeps the app open — or installs it, which on Android and
// iOS keeps it alive as a real app window. That is the whole mechanism.
//
// Two platform facts shape the code below:
//   * Android Chrome throws `TypeError: Illegal constructor` on `new Notification()` and will
//     only show one through a service-worker registration. Desktop accepts either. So we prefer
//     the registration and fall back to the constructor.
//   * iOS shows web notifications ONLY for a PWA added to the home screen, and only after a
//     permission request made from a real user gesture. Hence requestNotify() is wired to a
//     button, never called on load.

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied'

const BASE_TITLE = 'Lortnoc DM'

export function notifyPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as NotifyPermission
}

/** Ask for permission. MUST be called from a user gesture — Safari and iOS reject it otherwise,
 *  and Chrome ignores it on a page the user has not interacted with. */
export async function requestNotify(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return (await Notification.requestPermission()) as NotifyPermission
  } catch {
    return notifyPermission()
  }
}

/**
 * Show one notification. `tag` collapses repeats: re-notifying the same conversation replaces the
 * previous banner instead of stacking five of them, which is what a poll loop would otherwise do
 * every time it re-reads the same thread.
 */
export async function notify(title: string, body: string, tag: string): Promise<void> {
  if (notifyPermission() !== 'granted') return
  const options: NotificationOptions = {
    body,
    tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Renotify needs a tag; without it the second arrival of the same tag is silent, which reads
    // as "notifications stopped working" during a demo.
    renotify: true,
  } as NotificationOptions

  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.showNotification(title, options)
      return
    }
  } catch {
    /* fall through to the constructor — desktop does not need the registration */
  }

  try {
    new Notification(title, options)
  } catch {
    // Android Chrome without a registration lands here. Nothing more to try; the in-app badge
    // and the unread rows still carry the signal.
  }
}

/**
 * The signal that needs no permission and never fails: the tab title, plus the OS app badge where
 * the browser supports it. This is what actually carries a demo when someone declines the
 * permission prompt, so it is deliberately not conditional on anything.
 */
export function setBadge(count: number): void {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (count > 0) void nav.setAppBadge?.(count)
    else void nav.clearAppBadge?.()
  } catch {
    /* badging is a nicety; a browser that refuses it must not break the poll */
  }
}
