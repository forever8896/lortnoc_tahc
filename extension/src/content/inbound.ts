// Inbound: watch message bubbles, decode ours inline, leave others untouched.
// Dedupe by data-mid; the AES-SIV tag (via onDecode) is the detector, so non-ours
// bubbles are naturally skipped. `textContent` is lossy (custom emoji) — accepted (§6).
import type { TgClient } from './selectors'
import { selectorsFor } from './selectors'
import { attachCoverCard } from './ui'

/** "Undecided — ask again later" (no key yet, codec hiccup, network blip).
 *
 *  A SYMBOL on purpose. This used to be the string `'retry'`, and the branch below tests
 *  `typeof decoded === 'string'` — which `'retry'` satisfies. So every transient failure
 *  rendered the literal word "retry" into the bubble AND cached it as a final verdict, so the
 *  real message was never decoded again. When the swallowed bubble was a handshake OFFER, the
 *  frame was consumed as if it were a message and the connection silently never established.
 *  A symbol makes that mistake a compile error instead of a mystery. */
export const RETRY: unique symbol = Symbol('lortnoc.retry')

/** onDecode(coverText) → decoded message string, `null` if DEFINITELY not ours (safe to
 *  cache), or `RETRY` if it couldn't be decided now and should be tried again later. */
export type DecodeFn = (coverText: string) => Promise<string | null | typeof RETRY>

function readBubbleText(bubble: Element, textSel: string, timeSel: string): string {
  const msg = bubble.querySelector(textSel)
  if (!msg) return ''
  const clone = msg.cloneNode(true) as HTMLElement
  clone.querySelectorAll(`${timeSel}, .reactions, .MessageReactions, .document, .web`).forEach((n) => n.remove())
  clone.querySelectorAll('.lortnoc-decoded').forEach((n) => n.remove())
  return clone.textContent?.trim() ?? ''
}

function renderDecoded(
  bubble: Element,
  textSel: string,
  timeSel: string,
  decoded: string,
  cover: string,
): void {
  const msg = bubble.querySelector(textSel)
  if (!(msg instanceof HTMLElement)) return
  const time = msg.querySelector(timeSel)
  // remove existing content except the time/meta node
  Array.from(msg.childNodes).forEach((n) => {
    if (n === time) return
    if (n instanceof HTMLElement && n.matches(`${timeSel}, .reactions, .MessageReactions`)) return
    msg.removeChild(n)
  })
  const span = document.createElement('span')
  span.className = 'lortnoc-decoded'
  span.textContent = decoded + ' '
  // No `title` — the native tooltip rendered the same cover text in a second, uglier place and
  // raced the card on hover. The card below is the only presentation of it.
  attachCoverCard(span, cover) // hover → floating card with the cover text
  msg.insertBefore(span, msg.firstChild)
  ;(msg as HTMLElement).dataset.lortnocRendered = '1'
}

/** How many of the newest bubbles a scan will consider. Deep history is pre-session chatter and
 *  costs seconds per bubble to reject. */
const MAX_BACKLOG = 15
/** Measured floor: a 16-byte AES-SIV ciphertext — the smallest thing we ever encode — comes back
 *  as 27 words. Half that is a wide safety margin and still rejects most real chat for free. */
const MIN_COVER_WORDS = 13
/** Cap on preemptive restarts within one scan (see the loop in `scan`). */
const MAX_RESTARTS = 4

export function startInbound(
  client: TgClient,
  isReady: () => boolean,
  onDecode: DecodeFn,
): { reset: () => void } {
  const sel = selectorsFor(client)
  if (!sel) return { reset: () => {} }

  let scanning = false
  let dirty = false // DOM changed mid-scan → a newer bubble exists; restart from the top
  // decode decision cached per data-mid: {…}=ours, null=DEFINITELY not ours. Only a
  // definitive verdict is cached — a transient failure (no key yet / codec error) is NOT
  // cached, so the message is retried (e.g. after a handshake establishes the key).
  const seen = new Map<string, { decoded: string; cover: string } | null>()

  async function scan(): Promise<void> {
    if (scanning || !isReady()) return
    scanning = true
    try {
      // Restart whenever a bubble arrived mid-pass, so the newest message is always the next
      // one decoded rather than the last. Without this, an incoming handshake ACK queues behind
      // the entire visible history — minutes of decodes — and the handshake reads as broken.
      //
      // Bounded, because the restarts are self-triggering: rendering a decode mutates the DOM,
      // and Telegram mutates it constantly on its own. Anything still outstanding is picked up
      // by the next debounced scan, so a cap costs nothing but rules out a hot loop.
      for (let i = 0; i < MAX_RESTARTS; i++) {
        dirty = false
        await pass()
        if (!dirty) break
      }
    } finally {
      scanning = false
    }
  }

  async function pass(): Promise<void> {
    const container = Array.from(document.querySelectorAll<HTMLElement>(sel!.bubblesContainer)).find(
      (c) => c.offsetParent !== null,
    )
    if (!container) return

    // NEWEST FIRST, and only the newest MAX_BACKLOG. Decodes are sequential and each is a full
    // model round trip, so in DOM order a freshly-arrived bubble waits behind the entire
    // backlog — which is why a handshake took so long to land in a chat with history. Deep
    // history is pre-session chatter: seconds per bubble for a guaranteed miss.
    const bubbles = Array.from(container.querySelectorAll(sel!.bubble)).reverse().slice(0, MAX_BACKLOG)
    for (const bubble of bubbles) {
      if (dirty) return // something newer landed — restart the pass
      const el = bubble as HTMLElement
      const msg = bubble.querySelector(sel!.bubbleText) as HTMLElement | null
      if (!msg) continue
      const mid = bubble.getAttribute(sel!.midAttr) ?? ''

      // already decided for this message? re-apply from cache if Telegram re-rendered
      // the node (cheap), never re-hit the codec.
      if (mid && seen.has(mid)) {
        const hit = seen.get(mid)
        if (hit && msg.dataset.lortnocRendered !== '1') {
          renderDecoded(bubble, sel!.bubbleText, sel!.timeInMessage, hit.decoded, hit.cover)
        }
        continue
      }
      if (msg.dataset.lortnocRendered === '1') continue
      if (el.dataset.lortnocPending === '1') continue

      const text = readBubbleText(bubble, sel!.bubbleText, sel!.timeInMessage)
      if (!text) continue
      // Cheap local reject before spending a codec round trip. The smallest payload we ever
      // emit (a 16-byte AES-SIV ciphertext) encodes to 27 words; a handshake frame is larger
      // still. Anything under MIN_COVER_WORDS provably cannot be ours, and skipping it here
      // is the difference between a scan costing seconds and costing minutes.
      if (text.trim().split(/\s+/).length < MIN_COVER_WORDS) {
        if (mid) seen.set(mid, null)
        continue
      }
      el.dataset.lortnocPending = '1'
      // show the "decoding…" cue only if the decode is actually taking a moment (a GPT-2
      // decode is seconds; a quick not-cover-text 422 shouldn't flash it)
      const cueTimer = window.setTimeout(() => msg.classList.add('lortnoc-decoding'), 400)
      try {
        const decoded = await onDecode(text)
        window.clearTimeout(cueTimer)
        msg.classList.remove('lortnoc-decoding')
        if (decoded === RETRY) {
          // Transient (no key yet / codec error): record NOTHING, so the next scan tries
          // again. Must be tested before the string branch — see RETRY.
        } else if (typeof decoded === 'string') {
          renderDecoded(bubble, sel!.bubbleText, sel!.timeInMessage, decoded, text)
          if (mid) seen.set(mid, { decoded, cover: text })
        } else if (mid) {
          seen.set(mid, null) // DEFINITELY not ours — safe to never retry
        }
      } finally {
        window.clearTimeout(cueTimer)
        msg.classList.remove('lortnoc-decoding')
        delete el.dataset.lortnocPending
      }
    }
  }

  let timer: number | undefined
  const debouncedScan = (): void => {
    if (scanning) dirty = true // preempt the in-flight pass instead of dropping this mutation
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void scan(), 250)
  }

  new MutationObserver(debouncedScan).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  void scan()

  // Called when the conversation key changes (handshake establishes): drop cached "not
  // ours" verdicts and re-scan so pre-key messages decode.
  return {
    reset() {
      seen.clear()
      void scan()
    },
  }
}
