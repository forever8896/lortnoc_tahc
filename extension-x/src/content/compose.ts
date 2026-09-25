// Outbound: read the composer, replace it with cover text, and trigger a real post.
//
// Adapted from the Telegram build's compose.ts. THREE differences, all measured during the §7
// spike against live x.com rather than assumed — see the PRD §7 spike block:
//
//  1. Selection uses execCommand('selectAll'), NOT getSelection().selectAllChildren(el). On an
//     EMPTY Draft.js composer, selectAllChildren doubles the inserted text (the placeholder is
//     not a selectable text range, so the native insert and Draft's own beforeinput handler both
//     apply). Tweet 1 always has the user's text so it would look fine — but every later tweet in
//     a thread starts empty, which is exactly the auto-threading path this build depends on.
//  2. The post shortcut is Ctrl/Cmd+Enter, not Enter. Plain Enter inserts a newline in X's
//     composer, so intercepting it would break ordinary typing.
//  3. Both post-button testids are queried every time; the spike caught X flipping between them
//     mid-session.
//
// The `innerText` fallback the Telegram build keeps is deliberately ABSENT: against a controlled
// Draft.js model it silently fails to update the real content, so falling back to it would post
// stale text. Failing closed is correct here; a quiet wrong answer is not.
import {
  activeCompose,
  activePostButton,
  composeRoot,
  composers,
  composerAt,
  modelAccepted,
  visibleOnly,
  waitFor,
  COMPOSE,
  POST_BUTTON,
  THREAD_ADD,
} from './selectors'
import { shuffle, createProgress, type Progress } from './ui'
import { stripTag } from './crypto'

let swapping = false // true from the moment a post is intercepted until the cover is posted
let allowNextClick = false // set right before OUR programmatic click, so it passes through

export function readCompose(el: HTMLElement): string {
  return el.innerText.replace(/ /g, ' ').replace(/\n+$/, '').trim()
}

/**
 * Replace composer content so X actually posts `text` (not stale model text).
 *
 * SELF-VERIFYING BY DESIGN, and that is not defensive padding — it is the only thing that works.
 * Three separate attempts to characterise Draft.js's behaviour here were each disproven by the
 * next live measurement:
 *
 *   * on a PRISTINE composer, `selectAll` + `insertText` updates the model but DOUBLES the text —
 *     `selectAllChildren` does the same, so the earlier "use selectAll" fix was no fix at all;
 *   * after an `execCommand('delete')` the model DESYNCS, and later inserts update the DOM only:
 *     the editor shows exactly the right text while Post stays disabled and clicking does nothing;
 *   * on a WARM composer, replacing with different text is clean and the model sees it.
 *
 * So rather than model the state machine, do the operation and check BOTH observable outcomes,
 * retrying if either is wrong. `modelAccepted()` is the load-bearing half: reading the text back
 * catches doubling but is blind to the DOM-only failure, which is the one that silently posts
 * nothing.
 *
 * Returns false when the editor could not be driven — the caller must abort rather than post,
 * because a half-replaced composer still holds the user's plaintext.
 */
export async function replaceCompose(el: HTMLElement, text: string): Promise<boolean> {
  // Split off a TRAILING HASHTAG and insert it separately. Measured on live x.com 2026-08-20,
  // on a composer filled by REAL keystrokes so DOM and Draft's model were genuinely in sync:
  //
  //   insertText("quiet morning here ... #lortnoctahc")
  //     -> "quiet morning here ... #lortnoctahc#lortnoctahc"
  //
  // The body is clean; only the trailing hashtag duplicates, because X turns `#word` into an
  // entity and the programmatic insert applies it twice. It is deterministic, it survives a
  // retry (the retry re-inserts and doubles again), and it shipped: a real post went out reading
  // `...at all #lortnoctahc#lortnoctahc`.
  //
  // Inserting the tag-free body is clean, and a paste appends the tag exactly once. `stripTag`
  // tolerates both the missing space and a doubled tag, so the post decodes either way — this
  // just stops it LOOKING broken on a public timeline.
  // ONE insert of the whole string, and a TOLERANT check. Both halves are the fix.
  //
  // What actually happens on live x.com (measured on a composer typed into for real, so Draft's
  // model and the DOM were in sync): X turns a trailing `#word` into an entity and this insert
  // applies it twice, so the composer ends up `cover #lortnoctahc#lortnoctahc`. The body is
  // always clean; only the tag duplicates.
  //
  // The ORIGINAL bug was not the doubling — it was retrying on it. A strict `got === text` check
  // fails, the loop re-inserts, and each pass adds another tag: measured three tags in three
  // attempts. So the check asks the only question that matters — would a reader's stripTag
  // recover exactly the cover text the codec produced? A doubled tag answers yes (stripTag
  // removes every trailing occurrence), so it is accepted on the first pass and never compounded.
  //
  // A paste-based variant was tried and is WORSE: paste is undependable here — it silently
  // no-ops on some composer states — and mixing it with a fallback insert is what produced the
  // three-tag runaway. Simple and predictable beats clever and occasionally-clean.
  const want = stripTag(text) ?? text

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Select the WHOLE editor two ways. `execCommand('selectAll')` alone is not enough: it
      // needs a live caret inside the editor, and when it does not have one the following
      // insertText APPENDS instead of replacing — which leaves the user's plaintext sitting in
      // the composer with the cover text stuck on the end. A DOM Range over the contents pins
      // the selection regardless; execCommand then updates Draft's own selection state.
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      document.execCommand('selectAll')
      document.execCommand('insertText', false, text)
    } catch {
      return false
    }
    await new Promise((r) => setTimeout(r, 300)) // Draft re-renders asynchronously

    const got = readCompose(el)
    // modelAccepted() is the load-bearing half: the DOM can hold exactly the right text while
    // X's controlled model never saw it, and then clicking Post does nothing at all.
    if ((stripTag(got) ?? got) === want && modelAccepted(composeRoot(el))) return true
  }
  console.warn('[lortnoc] composer would not accept the text after 3 attempts')
  return false
}

/**
 * Take focus OFF the editor, then give X a moment, before pressing one of its controls.
 *
 * ⚠️ MEASURED on live x.com 2026-09-25. A real mouse press moves focus off the Draft.js editor,
 * and X commits the editor's text into its thread state on that blur. A programmatic .click()
 * (and even a full synthetic pointer sequence) does NOT move focus — so pressing "Add post"
 * that way threw away the part being edited: part 1 vanished when adding part 2, and part 2 was
 * emptied when adding part 3. Blurring first, then clicking, kept every part intact, three deep.
 */
async function commitThenPress(button: HTMLElement): Promise<void> {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  await new Promise((r) => setTimeout(r, 250))
  button.click()
}

/** Ctrl/Cmd+Enter is X's post shortcut. Plain Enter is a newline and must be left alone. */
function isPostShortcut(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing
}

/**
 * onSwap(realText) → the cover posts to publish, in order (hashtag already appended), or null to
 * ABORT. One entry = a single post; several = a thread.
 * Fail-closed: never auto-post plaintext when encoding fails.
 */
export type SwapFn = (realText: string, progress: Progress) => Promise<string[] | null>

/**
 * Lay a thread out across X's composers and publish the whole chain with ONE Post click.
 *
 * X threads are built before posting, not after: `addButton` mounts another composer
 * (`tweetTextarea_1`, `_2`, …) and a single Post publishes them together. That is the whole
 * reason threading here does not need N sequential posts — which matters, because the §7 spike
 * froze the renderer for 45 seconds under a tight execCommand loop, and posting in a loop is
 * also exactly what X's automation throttling watches for (PRD §10 Q4).
 *
 * The empty-composer doubling bug is live on this path: composers 1..n-1 all start empty, which
 * is precisely the case where the Telegram selectAllChildren approach duplicates the text.
 * `replaceCompose` uses execCommand('selectAll') for this reason — do not "simplify" it back.
 *
 * @returns true when the chain was laid out and Post was clicked
 */
async function layoutThread(parts: string[], first: HTMLElement): Promise<boolean> {
  // Everything below is scoped to the container this thread lives in — the compose dialog when
  // composing from the Post button — so the home timeline's own composer behind the modal can
  // never be mistaken for a thread part (see composeRoot).
  const root = composeRoot(first)
  if (!(await replaceCompose(first, parts[0]))) return false

  for (let i = 1; i < parts.length; i++) {
    // `addButton` only exists once the previous part has content — measured. Strictly visible
    // and inside this dialog: a hidden or foreign addButton would be clicked to no effect.
    const add = await waitFor(() => visibleOnly<HTMLElement>(THREAD_ADD, root))
    if (!add) {
      console.warn('[lortnoc] thread control not found — cannot post part', i + 1)
      return false
    }
    await commitThenPress(add)

    // Wait for the Nth composer in THIS dialog. Measured mount latency exceeded 1.5s.
    const box = await waitFor(() => (composers(root).length > i ? composerAt(i, root) : null), 8000)
    if (!box) {
      console.warn(`[lortnoc] composer ${i} never mounted (${composers(root).length} present)`)
      return false
    }
    if (!(await replaceCompose(box, parts[i]))) return false
  }
  return true
}

export function installPostInterceptor(isReady: () => boolean, onSwap: SwapFn): void {
  // Assumes `swapping` was set true synchronously by the caller, so no second post can slip
  // through the async gap while the codec runs.
  async function doSwapAndPost(): Promise<void> {
    const input = activeCompose()
    if (!input) {
      swapping = false
      return
    }
    const real = readCompose(input)
    if (!real) {
      swapping = false
      return
    }
    input.classList.add('lortnoc-busy') // persistent "working" cue during the slow codec call
    shuffle(input)
    const progress = createProgress(['Encrypting', 'Weaving cover text', 'Fitting to posts', 'Posting'])
    try {
      const parts = await onSwap(real, progress) // squeeze + encrypt + /encode (GPT-2 → seconds)
      if (parts == null || parts.length === 0) return // fail-closed: leave the draft, do not post
      if (!(await layoutThread(parts, input))) {
        console.warn('[lortnoc] could not lay the post out — not posting')
        progress.fail('Could not set the composer')
        return
      }
      // ─────────────────────────────────────────────────────────────────────────────────
      // LAST GATE BEFORE AN IRREVERSIBLE, PUBLIC ACTION: is the user's plaintext really gone?
      //
      // This exists because it happened. A failed replace left the composer holding
      // `meet at 8 <cover text> #lortnoctahc` — the real message and its own disguise, side by
      // side. Posting that publishes the plaintext to a public timeline forever, which is the
      // one mistake on this surface that cannot be walked back.
      //
      // Every check above asks "did the cover text arrive?". None of them asks "did the secret
      // leave?", and those are different questions: an APPEND satisfies the first and fails the
      // second. So this is checked separately, against the actual composer contents, at the last
      // possible moment, on every part of a thread.
      const root = composeRoot(input)
      // Checked page-wide as well as in the dialog: a leak into ANY composer is still a leak.
      const leaked = [...composers(root), ...composers(document)].find((c) => readCompose(c).includes(real))
      if (leaked) {
        console.error('[lortnoc] ABORT: the composer still contains your plaintext — not posting')
        progress.fail('Aborted — your real message was still in the box')
        return
      }

      const btn = activePostButton(root)
      if (!btn) {
        console.warn('[lortnoc] post button not found for', POST_BUTTON)
        progress.fail('Post button not found')
        return
      }
      progress.set(3, parts.length > 1 ? `${parts.length}-post thread` : 'via X')
      allowNextClick = true
      // Blur first so X commits the last part's text before "Post all" reads it (commitThenPress).
      await commitThenPress(btn) // real post; our click passes the interceptor via allowNextClick
      progress.done('Posted — reads like normal chatter')
      window.setTimeout(() => {
        allowNextClick = false
      }, 300)
    } finally {
      input.classList.remove('lortnoc-busy')
      window.setTimeout(() => {
        swapping = false
      }, 100)
    }
  }

  // Ctrl/Cmd+Enter (capture phase). When ready, ALWAYS block the native post — even while a swap
  // is already in flight — so nothing goes out as plaintext during the codec wait.
  document.addEventListener(
    'keydown',
    (e) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest?.(COMPOSE) || !isPostShortcut(e) || !isReady()) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!swapping) {
        swapping = true
        void doSwapAndPost()
      }
    },
    true,
  )

  // Post-button click (capture phase). Let OUR programmatic click through; block user clicks.
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest?.(POST_BUTTON)) return
      if (allowNextClick) {
        allowNextClick = false
        return // our own post — let it fire
      }
      if (!isReady()) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!swapping) {
        swapping = true
        void doSwapAndPost()
      }
    },
    true,
  )
}
