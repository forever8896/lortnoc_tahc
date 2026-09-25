// All X DOM selectors in ONE place — the same discipline as the Telegram build's selectors.ts,
// and the only file in this extension that is genuinely new engineering (PRD §7).
//
// Every hook below was verified against live x.com during the §7 spike (2026-08-12), not guessed
// from the PRD table. X ships new markup without notice; `data-testid` is the most durable hook
// available, and it is still only "most durable", not durable. Fail loudly when one resolves null.

/** Any editable composer — the first post of a thread AND every later part.
 *
 * ⚠️ RE-MEASURED on live x.com 2026-09-25, and it has CHANGED since 2026-08-18. Thread parts now
 * carry their own index: `tweetTextarea_0`, `tweetTextarea_1`, `tweetTextarea_2`… (in August every
 * part was a repeated `tweetTextarea_0`). Matching the prefix covers both schemes. The
 * `[contenteditable="true"]` half matters: X also renders `tweetTextarea_0_label` and
 * `tweetTextarea_0RichTextInputContainer`, which share the prefix but are not editors.
 *
 * Matching only `_0` is what broke every thread: part 2 was never found. */
export const COMPOSE = '[data-testid^="tweetTextarea_"][contenteditable="true"]'

/**
 * The post button — BOTH variants, always.
 *
 * The spike caught this flipping from `tweetButtonInline` to `tweetButton` *within a single
 * route*, mid-session. PRD §7 listed them as two variants as though a surface picks one; it does
 * not. Query both, take the visible one.
 */
export const POST_BUTTON = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'

/** Timeline column — the observer root. Low drift risk. */
export const TIMELINE = '[data-testid="primaryColumn"]'

/** One tweet in the feed. */
export const TWEET = 'article[data-testid="tweet"]'

/** The text body of a tweet. */
export const TWEET_TEXT = '[data-testid="tweetText"]'

/** "Add another post" — the thread control. Clicking it appends a composer to the thread; the
 *  whole chain then publishes with ONE Post click, which is why threading does not need N
 *  separate posts (and so does not trip X's automation throttling the way a loop would).
 *  The highest-drift hook in the set. */
export const THREAD_ADD = '[data-testid="addButton"]'

/**
 * The Nth composer in a thread — BY POSITION, because they do not have distinct ids.
 *
 * ⚠️ MEASURED against live x.com 2026-08-18, and it contradicts both PRD §7 ("indexed for
 * threads") and the obvious guess. Adding a thread part does NOT mount `tweetTextarea_1`: X
 * mounts a SECOND element carrying the very same `data-testid="tweetTextarea_0"`. Selecting by
 * `tweetTextarea_${i}` therefore finds nothing for i >= 1, and layoutThread would abort every
 * thread it ever tried to post.
 *
 * So the index is the position in document order among visible editable composers, and the
 * selector is constant.
 */
export const COMPOSER_ALL = COMPOSE

/**
 * The container a thread lives in: the open compose DIALOG if there is one, else the document.
 *
 * ⚠️ MEASURED 2026-09-25 — the bug that made long posts "break up and freeze". Composing from the
 * Post button opens a modal OVER the home timeline, and the timeline keeps its own visible,
 * editable "What's happening?" composer underneath. Counting composers page-wide made THAT the
 * "second composer", so part 2 of every thread was written into the home timeline box instead of
 * the thread, the modal's "Post all" stayed disabled, the check failed, and the retries piled the
 * text into the wrong box before aborting. Everything thread-related is scoped to this root.
 */
export function composeRoot(from?: Element | null): ParentNode {
  const anchor = from ?? document.activeElement
  const dialog = anchor?.closest?.('[role="dialog"]')
  if (dialog?.querySelector(COMPOSE)) return dialog
  // No composer focused: prefer an open compose dialog over the timeline behind it.
  const open = Array.from(document.querySelectorAll('[role="dialog"]')).find(
    (d) => (d as HTMLElement).offsetParent !== null && d.querySelector(COMPOSE),
  )
  return open ?? document
}

/** All visible composers in `root`, in document order. Index 0 is the first post of the thread. */
export function composers(root: ParentNode = composeRoot()): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(COMPOSE)).filter(
    (el) => el.offsetParent !== null,
  )
}

/** The Nth visible composer in `root`, or null if it has not mounted yet. */
export function composerAt(i: number, root: ParentNode = composeRoot()): HTMLElement | null {
  return composers(root)[i] ?? null
}

/**
 * Did X's controlled model register the current composer contents?
 *
 * THE DOM IS NOT A RELIABLE ANSWER. Measured live: an insert can leave the editor showing exactly
 * the right text while the model never saw it (Post stays disabled and clicking does nothing), and
 * a different insert can update the model while DOUBLING the DOM text. Reading `innerText` back
 * detects the second failure and misses the first.
 *
 * Post's disabled state is model-driven, so it is the honest oracle — and it works for thread
 * parts too, because X disables Post while ANY part of the thread is empty (measured).
 */
export function modelAccepted(root: ParentNode = composeRoot()): boolean {
  return activePostButton(root)?.getAttribute('aria-disabled') !== 'true'
}

/** Wait for `get` to return something, polling. Threading is inherently async: clicking
 *  addButton mounts the next composer some frames later, and acting before it exists is the
 *  obvious way to write a flaky poster. */
export async function waitFor<T>(
  get: () => T | null,
  timeoutMs = 4000,
  stepMs = 60,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = get()
    if (got) return got
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** Are we on a surface where the overlay makes sense? */
export function onX(): boolean {
  return location.hostname === 'x.com' || location.hostname === 'twitter.com'
}

/**
 * The visible element among possibly many matches. X mounts several composers and both post-button
 * variants at once, and only one of each is real at any moment.
 *
 * Falls back to the first match when NOTHING is visible, which is right for "act on the composer
 * the user is typing in": better a best guess than nothing.
 *
 * ⚠️ It is wrong for anything that WAITS for an element to appear — see `visibleOnly`.
 */
export function visible<T extends HTMLElement>(selector: string, root: ParentNode = document): T | null {
  const all = Array.from(root.querySelectorAll<T>(selector))
  return all.find((el) => el.offsetParent !== null) ?? all[0] ?? null
}

/**
 * Strictly visible: null when every match is hidden, with no fallback.
 *
 * Threading needs this and `visible` is actively harmful there. X keeps the next composer in the
 * DOM but hidden until `addButton` mounts it, so `visible(composeAt(1))` returns that hidden node
 * immediately — a poller built on it never waits at all, and `replaceCompose` then writes a thread
 * part into an editor that is not mounted. The part is silently lost and the thread posts short.
 *
 * The browser tier pins this (`test/browser/x-dom.test.mjs`, "composeAt(n) addresses the indexed
 * composers a thread mounts"), because the failure is invisible from the outside: the post
 * succeeds, it is just missing a piece.
 */
export function visibleOnly<T extends HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return Array.from(root.querySelectorAll<T>(selector)).find((el) => el.offsetParent !== null) ?? null
}

/** The composer the user is writing in: the focused one, else the first in the open dialog, else
 *  the first visible one. Page-wide "first visible" would pick the timeline box behind a modal. */
export function activeCompose(): HTMLElement | null {
  const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>(COMPOSE)
  if (focused) return focused
  return visible<HTMLElement>(COMPOSE, composeRoot())
}

/** The post button belonging to `root` — the modal's "Post all", never the timeline's "Post". */
export function activePostButton(root: ParentNode = composeRoot()): HTMLElement | null {
  return visible<HTMLElement>(POST_BUTTON, root)
}

/**
 * A stable id for a tweet, taken from its permalink.
 *
 * This replaces Telegram's `data-mid`. It matters more here than there: X's feed is VIRTUALISED,
 * so article nodes are recycled as you scroll — a DOM-identity or index-based cache would hand
 * one tweet's decode to a different tweet. The status id in the permalink is the only identifier
 * that survives recycling.
 *
 * Returns null for the rare tweet with no permalink yet (still posting); the caller treats that
 * as "not decidable now" rather than caching a verdict against a key that will change.
 */
export function tweetId(article: Element): string | null {
  for (const a of article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')) {
    const m = a.getAttribute('href')?.match(/\/status\/(\d+)/)
    if (m) return m[1]
  }
  return null
}
