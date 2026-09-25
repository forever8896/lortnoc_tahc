// Content script — injected into ONE tab on demand (shortcut, right-click, popup). It never holds
// plaintext: writing happens in the sheet iframe and reading in the reveal iframe, both extension
// origin, so the page's scripts, autosave and analytics cannot see either (PRD §13.4 — typing into
// the site's own box would hand the plaintext to the site before it was ever encoded).
//
// This script only: remembers which box you were in, opens the frames, puts the COVER text into
// that box, and marks marker-tagged blocks on the page with a Reveal chip.
import type { FrameToContent, ContentToFrame } from '../shared/messages'
import { findMarkedBlocks } from './scan'
import { insertCover, editableTarget } from './insert'

type Action = { action: 'compose' } | { action: 'reveal'; text: string } | { action: 'scan' }

const W = window as unknown as { __lortnocEverywhere?: boolean }
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

function scan(): number {
  let n = 0
  for (const block of findMarkedBlocks(document.body)) {
    if (block.dataset.lortnocChip) continue
    block.dataset.lortnocChip = '1'
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.textContent = '🔒 Reveal'
    chip.title = 'lortnoc tahc — try to open this'
    Object.assign(chip.style, {
      font: '600 12px/1 system-ui, sans-serif', padding: '4px 8px', margin: '4px 0',
      borderRadius: '999px', border: '1px solid #12C4BE', background: '#12C4BE', color: '#000', cursor: 'pointer',
    } as CSSStyleDeclaration)
    chip.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      openFrame('reveal', `#t=${encodeURIComponent(block.innerText)}`, chip.getBoundingClientRect())
    })
    block.insertAdjacentElement('afterend', chip)
    n++
  }
  return n
}

function run(a: Action) {
  if (a.action === 'compose') {
    target = editableTarget()
    openFrame('sheet', target ? '' : '#nofield')
  } else if (a.action === 'reveal') {
    const r = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0).getBoundingClientRect() : undefined
    openFrame('reveal', `#t=${encodeURIComponent(a.text)}`, r)
  } else if (a.action === 'scan') {
    const n = scan()
    if (!n) openFrame('reveal', '#none')
  }
}

// Injected once per action, so register listeners once per page.
if (!W.__lortnocEverywhere) {
  W.__lortnocEverywhere = true
  window.addEventListener('message', onFrameMessage)
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeFrame(), true)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.lortnocAction) run(msg.lortnocAction as Action)
  })
}
