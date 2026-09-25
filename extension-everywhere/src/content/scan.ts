// Finding marked posts on a page. The marker (#lortnoctahc) is the cheap pre-filter — without it,
// every paragraph on the web would cost a model decode (the X rationale, shared/xframe.mjs). Posts
// written in high-risk mode carry no marker and are reached by selecting them + right-click Reveal.

const MARKER = '#lortnoctahc'
const BLOCK = /^(block|flex|grid|list-item|table-cell)$/

/** The smallest block-level element around each marker occurrence, outermost duplicates removed. */
export function findMarkedBlocks(root: HTMLElement): HTMLElement[] {
  const found = new Set<HTMLElement>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue?.toLowerCase().includes(MARKER) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let el = n.parentElement
    while (el && el !== root && !BLOCK.test(getComputedStyle(el).display)) el = el.parentElement
    // Never our own UI, and never an editable box (the user's own unsent draft).
    if (el && el !== root && !el.closest('[contenteditable="true"],textarea') && !el.dataset.lortnocChip) found.add(el)
  }
  // A marker inside a nested block also sits inside its ancestors — keep only the innermost.
  return [...found].filter((el) => ![...found].some((o) => o !== el && el.contains(o)))
}
