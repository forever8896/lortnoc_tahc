// Deep scan: find hidden posts on a page WITHOUT any marker.
//
// Posts carry no tag (a hashtag is exactly the "this person is hiding something" flag the high-risk
// story warns about), so finding them is two steps, both in the service worker:
//   1. shape — blocks that look like cover text (shared/webframe.mjs looksLikeCover)
//   2. proof — the codec decodes each candidate and inspect() checks it is really a lortnoc frame.
// This file only COLLECTS text blocks. It must import nothing shared with other entries: Chrome runs
// an injected script as a classic script, so any cross-chunk `import` kills it (measured: "Cannot
// use import statement outside a module" once this file imported shared/webframe.mjs).

const BLOCK = /^(block|flex|grid|list-item|table-cell)$/
const MAX_BLOCKS = 200

/** Innermost block-level elements with at least `minWords` words of their own text. */
export function collectBlocks(root: HTMLElement, minWords = 25): HTMLElement[] {
  const seen = new Set<HTMLElement>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.nodeValue?.trim().length ?? 0) > 20 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let el = n.parentElement
    while (el && el !== root && !BLOCK.test(getComputedStyle(el).display)) el = el.parentElement
    if (!el || el === root || seen.has(el)) continue
    // Never the user's own unsent draft, never our UI.
    if (el.closest('[contenteditable="true"],textarea,[data-lortnoc-chip]')) continue
    seen.add(el)
  }
  const blocks = [...seen].filter((el) => el.innerText.trim().split(/\s+/).length >= minWords)
  return blocks.filter((el) => !blocks.some((o) => o !== el && el.contains(o))).slice(0, MAX_BLOCKS)
}

/** Ask the service worker which of these blocks are posts THIS reader can open (sealed, opened with
 *  their keyring) — and which are older posts that show their rule (legacy: Reveal as before). */
export async function confirmPosts(blocks: HTMLElement[]): Promise<{ legacy: HTMLElement[]; sealed: { el: HTMLElement; id: string }[] }> {
  const r = (await chrome.runtime.sendMessage({ type: 'FIND_POSTS', texts: blocks.map((b) => b.innerText) })) as
    | { ok: true; data: { found: number[]; opened?: { i: number; id: string }[] } }
    | { ok: false }
  if (!r?.ok) return { legacy: [], sealed: [] }
  return { legacy: r.data.found.map((i) => blocks[i]), sealed: (r.data.opened ?? []).map(({ i, id }) => ({ el: blocks[i], id })) }
}
