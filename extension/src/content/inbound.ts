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
  span.title = `Telegram stored: “${cover}”` // accessibility fallback
  attachCoverCard(span, cover) // hover → floating card with the cover text
  msg.insertBefore(span, msg.firstChild)
  ;(msg as HTMLElement).dataset.lortnocRendered = '1'
}

export function startInbound(
  client: TgClient,
  isReady: () => boolean,
  onDecode: DecodeFn,
): { reset: () => void } {
  const sel = selectorsFor(client)
  if (!sel) return { reset: () => {} }

  let scanning = false
  // decode decision cached per data-mid: {…}=ours, null=DEFINITELY not ours. Only a
  // definitive verdict is cached — a transient failure (no key yet / codec error) is NOT
  // cached, so the message is retried (e.g. after a handshake establishes the key).
  const seen = new Map<string, { decoded: string; cover: string } | null>()

  async function scan(): Promise<void> {
    if (scanning || !isReady()) return
    scanning = true
    try {
      const container = Array.from(document.querySelectorAll<HTMLElement>(sel!.bubblesContainer)).find(
        (c) => c.offsetParent !== null,
      )
      if (!container) return
      // NEWEST FIRST. Decodes are sequential and each is a full model round trip, so in DOM
      // order a freshly-arrived bubble waits behind the entire backlog — which is why a
      // handshake took so long to land in a chat with history. The message that just arrived is
      // also the one being waited on.
      const bubbles = Array.from(container.querySelectorAll(sel!.bubble)).reverse()
      for (const bubble of bubbles) {
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
    } finally {
      scanning = false
    }
  }

  let timer: number | undefined
  const debouncedScan = (): void => {
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
