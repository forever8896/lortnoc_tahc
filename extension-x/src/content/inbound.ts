// Inbound: watch the timeline, decode our posts inline, leave everything else untouched.
//
// Adapted from the Telegram build's inbound.ts. Two structural differences (PRD §7):
//
//  1. **Dedupe is by permalink status id, not DOM node.** X's feed is VIRTUALISED — article nodes
//     are recycled as you scroll, so any cache keyed on the element (or on its position) would
//     eventually hand one tweet's decode to a different tweet. `tweetId()` reads the status id out
//     of the permalink, which is the only identifier that survives recycling.
//  2. **The hashtag replaces MIN_COVER_WORDS as the cheap reject.** A full arithmetic decode per
//     tweet is not viable across a feed, so a tweet without the tag never costs a model call.
//     That is also precisely why the tag has to exist, and why PRD §3 says deniability does not
//     transfer to this surface.
import { TIMELINE, TWEET, TWEET_TEXT, tweetId } from './selectors'
import { stripTag } from './crypto'
import { attachCoverCard } from './ui'

/** "Undecided — ask again later" (codec hiccup, network blip).
 *
 *  A SYMBOL on purpose, inherited from the Telegram build where this was the string 'retry' and
 *  the branch below tests `typeof decoded === 'string'` — which 'retry' satisfies. Every transient
 *  failure then rendered the literal word "retry" into the post AND cached it as a final verdict,
 *  so the real message was never decoded again. A symbol makes that a compile error. */
export const RETRY: unique symbol = Symbol('lortnoc.retry')

/** onDecode(coverText) → the decoded message, `null` if DEFINITELY not ours (safe to cache), or
 *  `RETRY` if it could not be decided now and should be tried again later. */
export type DecodeFn = (coverText: string) => Promise<string | null | typeof RETRY>

/** How many of the newest tweets a scan will consider. A feed is unbounded and each decode is a
 *  full model round trip, so this is the difference between a scan costing seconds and minutes. */
const MAX_BACKLOG = 25
/** Cap on preemptive restarts within one scan (see the loop in `scan`). */
const MAX_RESTARTS = 4

function readTweetText(article: Element): string {
  const el = article.querySelector(TWEET_TEXT)
  if (!el) return ''
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.lortnoc-decoded').forEach((n) => n.remove())
  return clone.textContent?.trim() ?? ''
}

function renderDecoded(article: Element, decoded: string, cover: string): void {
  const el = article.querySelector(TWEET_TEXT)
  if (!(el instanceof HTMLElement)) return
  el.textContent = ''
  const span = document.createElement('span')
  span.className = 'lortnoc-decoded'
  span.textContent = decoded
  attachCoverCard(span, cover) // hover → floating card with the cover text X actually stored
  el.appendChild(span)
  el.dataset.lortnocRendered = '1'
}

export function startInbound(isReady: () => boolean, onDecode: DecodeFn): { reset: () => void } {
  let scanning = false
  let dirty = false // DOM changed mid-scan → newer tweets exist; restart from the top

  // Decode decision cached per status id: {…} = ours, null = DEFINITELY not ours. Only a
  // definitive verdict is cached — a transient failure is NOT, so it is retried on a later scan.
  const seen = new Map<string, { decoded: string; cover: string } | null>()

  async function scan(): Promise<void> {
    if (scanning || !isReady()) return
    scanning = true
    try {
      // Restart whenever a tweet arrived mid-pass, so the newest is always decoded next rather
      // than last. Bounded, because the restarts are self-triggering: rendering a decode mutates
      // the DOM, and X mutates it constantly on its own. Anything still outstanding is picked up
      // by the next debounced scan, so the cap costs nothing but rules out a hot loop.
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
    const root = document.querySelector(TIMELINE) ?? document.body
    const articles = Array.from(root.querySelectorAll(TWEET)).slice(0, MAX_BACKLOG)

    for (const article of articles) {
      if (dirty) return // something newer landed — restart the pass
      const el = article as HTMLElement
      const textEl = article.querySelector(TWEET_TEXT) as HTMLElement | null
      if (!textEl) continue

      const id = tweetId(article)
      // No permalink yet (still posting). Do NOT cache a verdict against an id that will change.
      if (!id) continue

      if (seen.has(id)) {
        const hit = seen.get(id)
        // Re-apply from cache when virtualisation recycled the node — cheap, never re-hits the codec.
        if (hit && textEl.dataset.lortnocRendered !== '1') renderDecoded(article, hit.decoded, hit.cover)
        continue
      }
      if (textEl.dataset.lortnocRendered === '1') continue
      if (el.dataset.lortnocPending === '1') continue

      // THE cheap reject: no hashtag, no model call. Replaces Telegram's MIN_COVER_WORDS.
      const cover = stripTag(readTweetText(article))
      if (cover === null || cover === '') {
        seen.set(id, null)
        continue
      }

      el.dataset.lortnocPending = '1'
      // Show the "decoding…" cue only if it is actually taking a moment.
      const cueTimer = window.setTimeout(() => textEl.classList.add('lortnoc-decoding'), 400)
      try {
        const decoded = await onDecode(cover)
        if (decoded === RETRY) {
          // Transient: record NOTHING, so the next scan tries again. Must be tested BEFORE the
          // string branch — see RETRY.
        } else if (typeof decoded === 'string') {
          renderDecoded(article, decoded, cover)
          seen.set(id, { decoded, cover })
        } else {
          seen.set(id, null) // DEFINITELY not ours — safe to never retry
        }
      } finally {
        window.clearTimeout(cueTimer)
        textEl.classList.remove('lortnoc-decoding')
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

  return {
    reset() {
      seen.clear()
      void scan()
    },
  }
}
