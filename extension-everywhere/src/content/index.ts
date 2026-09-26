// Content script — injected into ONE tab on demand (shortcut, right-click, popup). It never holds
// plaintext: writing happens in the sheet iframe and reading in the reveal iframe, both extension
// origin, so the page's scripts, autosave and analytics cannot see either (PRD §13.4 — typing into
// the site's own box would hand the plaintext to the site before it was ever encoded).
//
// This script only: remembers which box you were in, opens the frames, puts the COVER text into
// that box, and marks marker-tagged blocks on the page with a Reveal chip.
import type { FrameToContent, ContentToFrame } from '../shared/messages'
import { collectBlocks, confirmPosts } from './scan'
import { insertCover, editableTarget, editableFrom } from './insert'

type Action = { action: 'compose' } | { action: 'reveal'; text: string } | { action: 'scan' }

const W = window as unknown as { __lortnocEverywhere?: boolean }
/** Show the focus pill only on sites the user switched to "Always on" — asked, not guessed: the
 *  same script also arrives by a one-off click (shortcut / right-click) on sites that are not. */
let AUTO = false
const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin
const Z = '2147483647'

let target: HTMLElement | null = null
let frame: HTMLIFrameElement | null = null

function closeFrame() {
  frame?.remove()
  frame = null
}

function openFrame(page: 'sheet' | 'reveal', hash = '', anchor?: DOMRect) {
  closeFrame()
  const f = document.createElement('iframe')
  f.src = chrome.runtime.getURL(`src/${page}/index.html`) + hash
  f.setAttribute('allow', 'clipboard-write')
  const w = page === 'sheet' ? 420 : 380
  const top = anchor ? Math.min(Math.max(8, anchor.bottom + 8), innerHeight - 360) : 16
  const left = anchor ? Math.min(Math.max(8, anchor.left), innerWidth - w - 8) : innerWidth - w - 16
  Object.assign(f.style, {
    position: 'fixed', top: `${top}px`, left: `${left}px`, width: `${w}px`,
    height: page === 'sheet' ? '560px' : '320px', maxHeight: 'calc(100vh - 16px)',
    border: '0', borderRadius: '14px', zIndex: Z, colorScheme: 'normal',
    boxShadow: '0 18px 60px rgba(0,0,0,0.45)', background: 'transparent',
  } as CSSStyleDeclaration)
  document.documentElement.appendChild(f)
  frame = f
}

function onFrameMessage(e: MessageEvent) {
  // Only OUR frame. Anything else on the page can post messages too.
  if (!frame || e.source !== frame.contentWindow || e.origin !== EXT_ORIGIN) return
  const m = e.data as FrameToContent
  if (m?.lortnoc === 'close') return closeFrame()
  if (m?.lortnoc === 'resize' && frame) frame.style.height = `${Math.min(m.height, innerHeight - 16)}px`
  if (m?.lortnoc === 'insert') {
    const how = target && insertCover(target, m.text) ? 'field' : 'failed'
    frame.contentWindow?.postMessage({ lortnoc: 'inserted', how } satisfies ContentToFrame, EXT_ORIGIN)
  }
}

/** A post the keyring opened: its text waits in the extension (never in this page) until clicked. */
function addChip(block: HTMLElement, sealedId?: string) {
  if (block.dataset.lortnocChip) return // one button per post
  block.dataset.lortnocChip = '1'
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.dataset.lortnocChip = '1'
  chip.textContent = sealedId ? '🔓 Hidden message for you' : '🔒 Reveal'
  chip.title = sealedId ? 'lortnoc tahc — your keyring opened this' : 'lortnoc tahc — try to open this'
  Object.assign(chip.style, {
    font: '600 12px/1 system-ui, sans-serif', padding: '4px 8px', margin: '4px 0',
    borderRadius: '999px', border: '1px solid #12C4BE', background: '#12C4BE', color: '#000', cursor: 'pointer',
  } as CSSStyleDeclaration)
  chip.addEventListener('click', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    openFrame('reveal', sealedId ? `#s=${sealedId}` : `#t=${encodeURIComponent(block.innerText)}`, chip.getBoundingClientRect())
  })
  block.insertAdjacentElement('afterend', chip)
}

/** A small progress note in the corner — page-visible, but it says nothing about any message. */
function toast(text: string | null) {
  let t = document.getElementById('lortnoc-scan-toast')
  if (!text) return void t?.remove()
  if (!t) {
    t = document.createElement('div')
    t.id = 'lortnoc-scan-toast'
    Object.assign(t.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: Z, padding: '10px 14px', borderRadius: '10px',
      background: '#08080a', color: '#edeae4', font: '400 13px system-ui, sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,.4)',
    } as CSSStyleDeclaration)
    document.documentElement.appendChild(t)
  }
  t.textContent = text
}

/** Deep scan: collect text blocks here; the service worker filters by shape and asks the codec. */
async function scan(quiet = false): Promise<number> {
  const blocks = collectBlocks(document.body).filter((b) => !b.dataset.lortnocChip && !b.dataset.lortnocSeen)
  if (!blocks.length) return 0
  if (!quiet) toast('lortnoc tahc · looking for hidden posts…')
  // quiet (automatic) scans stay silent unless they take a while — the codec needs seconds per post
  const slow = quiet ? setTimeout(() => toast('lortnoc tahc · checking this page for hidden posts…'), 1200) : undefined
  // mark BEFORE asking: a scan takes seconds, and our own chips/toast trigger the observer meanwhile
  for (const b of blocks) b.dataset.lortnocSeen = '1'
  const got = await confirmPosts(blocks).catch(() => {
    for (const b of blocks) delete b.dataset.lortnocSeen // codec hiccup: let the next scan retry them
    return { legacy: [] as HTMLElement[], sealed: [] as { el: HTMLElement; id: string }[] }
  })
  got.sealed.forEach(({ el, id }) => addChip(el, id))
  got.legacy.forEach((el) => addChip(el))
  const found = [...got.sealed.map((x) => x.el), ...got.legacy]
  clearTimeout(slow)
  if (found.length || !quiet || slow) {
    toast(found.length ? `lortnoc tahc · ${found.length} hidden ${found.length === 1 ? 'message' : 'messages'} for you` : null)
    setTimeout(() => toast(null), 2500)
  }
  return found.length
}

// The keyring grew (a wallet, World ID, a passphrase): posts on this page that stayed shut may open
// now — a post never depends on what the reader had when it was WRITTEN, only on what they hold now.
// Re-check them, but only on a page that was scanned at all.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.keyring) return
  const sig = (k?: { token?: string; claims?: unknown; pass?: unknown[] }) => JSON.stringify([k?.token, k?.claims, k?.pass?.length])
  if (sig(ch.keyring.oldValue) === sig(ch.keyring.newValue)) return
  const shut = document.querySelectorAll<HTMLElement>('[data-lortnoc-seen]:not([data-lortnoc-chip])')
  if (!shut.length) return
  shut.forEach((el) => delete el.dataset.lortnocSeen)
  void scan(true)
})

/** "Always on" sites: find hidden posts on load, and again when new posts appear (feeds, replies). */
function autoScan() {
  void scan(true)
  let t: ReturnType<typeof setTimeout> | undefined
  new MutationObserver(() => {
    clearTimeout(t)
    t = setTimeout(() => void scan(true), 1500)
  }).observe(document.body, { childList: true, subtree: true })
}

function run(a: Action) {
  if (a.action === 'compose') {
    target = editableTarget()
    openFrame('sheet', target ? '' : '#nofield')
  } else if (a.action === 'reveal') {
    const r = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0).getBoundingClientRect() : undefined
    openFrame('reveal', `#t=${encodeURIComponent(a.text)}`, r)
  } else if (a.action === 'scan') {
    // a manual scan re-checks everything not yet opened — the keyring may have changed since
    document.querySelectorAll<HTMLElement>('[data-lortnoc-seen]:not([data-lortnoc-chip])').forEach((el) => delete el.dataset.lortnocSeen)
    // blocks with a chip were already found (e.g. by the automatic scan) — only "none" if there are none
    void scan().then((n) => n || document.querySelector('[data-lortnoc-chip]:not(button)') || openFrame('reveal', '#none'))
  }
}

// ---------------------------------------------------------------------------
// The focus pill — only on sites the user switched to "Always on". A small 🔒 at the corner of the
// focused box; clicking it opens the sheet aimed at that box. We only watch WHICH box is focused,
// never what is typed into it (typing happens in the sheet).
// ---------------------------------------------------------------------------
let pill: HTMLButtonElement | null = null
let pillFor: HTMLElement | null = null
function showPill(box: HTMLElement) {
  if (!pill) {
    pill = document.createElement('button')
    pill.type = 'button'
    pill.dataset.lortnocChip = '1'
    pill.textContent = '🔒'
    pill.title = 'Write this hidden — lortnoc tahc'
    Object.assign(pill.style, {
      position: 'fixed', zIndex: Z, width: '28px', height: '28px', borderRadius: '50%', border: '0', cursor: 'pointer',
      background: '#12C4BE', color: '#000', font: '14px/28px system-ui', padding: '0', boxShadow: '0 4px 14px rgba(0,0,0,.3)',
    } as CSSStyleDeclaration)
    // mousedown, not click: keep focus in the box so it stays the target
    pill.addEventListener('mousedown', (e) => {
      e.preventDefault()
      target = pillFor
      openFrame('sheet')
      hidePill()
    })
    document.documentElement.appendChild(pill)
  }
  pillFor = box
  const r = box.getBoundingClientRect()
  pill.style.left = `${Math.min(r.right - 34, innerWidth - 36)}px`
  pill.style.top = `${Math.max(4, r.bottom - 34)}px`
  pill.style.display = 'block'
}
function hidePill() {
  if (pill) pill.style.display = 'none'
}

// Injected once per action, so register listeners once per page.
if (!W.__lortnocEverywhere) {
  W.__lortnocEverywhere = true
  window.addEventListener('message', onFrameMessage)
  // The target follows the user: whichever box they click while the sheet is open is where the
  // cover goes. So "open the sheet first, pick the box after" works — the popup button's natural
  // order (measured: opening with no box focused made every insert fail).
  document.addEventListener('focusin', (e) => {
    const t = editableFrom(e.composedPath()[0] ?? e.target)
    if (t && frame) target = t
    if (t && !frame && AUTO) showPill(t)
  }, true)
  chrome.runtime.sendMessage({ type: 'SITE_STATE', origin: location.origin })
    .then((r: { ok?: boolean; data?: { on?: boolean } }) => {
      AUTO = !!r?.data?.on
      const t = editableFrom(document.activeElement)
      if (AUTO && t && !frame) showPill(t)
      if (AUTO) autoScan()
    })
    .catch(() => {})
  document.addEventListener('focusout', () => setTimeout(() => {
    if (!editableFrom(document.activeElement)) hidePill()
  }, 150), true)
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeFrame(), true)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.lortnocAction) run(msg.lortnocAction as Action)
  })
}
