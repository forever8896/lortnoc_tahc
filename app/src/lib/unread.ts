// Unread bookkeeping — what turns "the poll found a message" into "you have a message".
//
// There is no server-side read state (§5.5: there is no account), so "unread" is a purely local
// watermark: the newest inbound timestamp this device has acknowledged, per peer. Two devices
// therefore track unread independently, which is the honest consequence of having no server and
// is fine — each device notifies its own human.
//
// The one rule that matters: a device that has NEVER stored a watermark seeds itself silently.
// Otherwise signing in on a second device would fire a banner for every message in your history,
// which is exactly the behaviour that makes people turn notifications off.
import type { Conversation, Message } from './types'

const MARKS = 'lortnoc.unread.marks.v1' // peer handle -> newest inbound ts acknowledged
const KNOCKS = 'lortnoc.unread.knocks.v1' // knock ids already announced

export type Watermarks = Record<string, number>

/** Null — not {} — when this device has never written one. The caller needs that distinction to
 *  know whether to seed silently or to treat everything as new. */
export function loadWatermarks(): Watermarks | null {
  try {
    const raw = localStorage.getItem(MARKS)
    return raw ? (JSON.parse(raw) as Watermarks) : null
  } catch {
    return null
  }
}

export function saveWatermarks(marks: Watermarks): void {
  try {
    localStorage.setItem(MARKS, JSON.stringify(marks))
  } catch {
    /* a full or blocked store must not break the inbox — worst case we re-notify once */
  }
}

export function loadAnnouncedKnocks(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KNOCKS) || '[]') as string[]
  } catch {
    return []
  }
}

export function saveAnnouncedKnocks(ids: string[]): void {
  try {
    // Bounded: knock ids are relay-side and expire after 7 days, so an unbounded list would grow
    // forever to remember blobs that no longer exist.
    localStorage.setItem(KNOCKS, JSON.stringify(ids.slice(-200)))
  } catch {
    /* see above */
  }
}

/** The newest inbound message in a conversation, or null if the peer has not spoken. */
export function newestInbound(conv: Conversation, me: string): Message | null {
  let newest: Message | null = null
  for (const m of conv.messages) {
    if (m.from === me) continue
    if (!newest || m.ts > newest.ts) newest = m
  }
  return newest
}

/**
 * Inbound messages past each peer's watermark. Pure, so the notification rule is testable without
 * a browser: given the same conversations and marks it always names the same messages.
 */
export function unreadByPeer(
  convos: Conversation[],
  me: string,
  marks: Watermarks,
): Record<string, Message[]> {
  const out: Record<string, Message[]> = {}
  for (const c of convos) {
    const mark = marks[c.peer] ?? 0
    const fresh = c.messages.filter((m) => m.from !== me && m.ts > mark).sort((a, b) => a.ts - b.ts)
    if (fresh.length) out[c.peer] = fresh
  }
  return out
}

/** How recent a message has to be to survive first-run seeding. Covers the ordinary case of
 *  someone messaging you seconds before you open the app on a second device — without it, that
 *  message is indistinguishable from history and gets marked read before you ever see it. */
export const FRESH_MS = 5 * 60 * 1000

/**
 * The watermark set that means "all caught up", for a device that has never stored one.
 *
 * Not simply "newest inbound ts": anything that landed in the last FRESH_MS is left BELOW the
 * mark so it still notifies. History stays silent — which is the point of seeding — but a message
 * sent moments before you opened the app is not silently swallowed. `now` is a parameter so this
 * stays pure and testable.
 */
export function seedWatermarks(convos: Conversation[], me: string, now = Date.now()): Watermarks {
  const cutoff = now - FRESH_MS
  const marks: Watermarks = {}
  for (const c of convos) {
    // The newest inbound message that is old enough to count as already-seen.
    let mark = 0
    for (const m of c.messages) {
      if (m.from === me || m.ts > cutoff) continue
      if (m.ts > mark) mark = m.ts
    }
    marks[c.peer] = mark
  }
  return marks
}
