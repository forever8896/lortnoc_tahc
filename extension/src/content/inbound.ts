// Inbound: watch message bubbles, decode ours inline, leave others untouched.
// Dedupe by data-mid; the AES-SIV tag (via onDecode) is the detector, so non-ours
// bubbles are naturally skipped. `textContent` is lossy (custom emoji) — accepted (§6).
import type { TgClient } from './selectors'
import { selectorsFor } from './selectors'

/** onDecode(coverText) → decoded message, or null if not one of ours. */
export type DecodeFn = (coverText: string) => Promise<string | null>

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
  // hover shows what Telegram actually stored (the cover text)
  span.title = `Telegram stores:\n“${cover}”`
  span.dataset.cover = cover
  msg.insertBefore(span, msg.firstChild)
  ;(msg as HTMLElement).dataset.lortnocRendered = '1'
}

export function startInbound(client: TgClient, isReady: () => boolean, onDecode: DecodeFn): void {
  const sel = selectorsFor(client)
  if (!sel) return

  let scanning = false
  // decode decision cached per data-mid: {…}=ours, null=not ours. Each message hits the
  // codec at most ONCE — critical now that a GPT-2 decode costs seconds.
  const seen = new Map<string, { decoded: string; cover: string } | null>()

  async function scan(): Promise<void> {
    if (scanning || !isReady()) return
    scanning = true
    try {
      const container = Array.from(document.querySelectorAll<HTMLElement>(sel!.bubblesContainer)).find(
        (c) => c.offsetParent !== null,
      )
      if (!container) return
      const bubbles = Array.from(container.querySelectorAll(sel!.bubble))
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
        try {
          const decoded = await onDecode(text)
          if (decoded != null) {
            renderDecoded(bubble, sel!.bubbleText, sel!.timeInMessage, decoded, text)
            if (mid) seen.set(mid, { decoded, cover: text })
          } else if (mid) {
            seen.set(mid, null) // not ours — remember, so we never decode it again
          }
        } finally {
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
}
