// Injected styles + the "shuffle" animation (masks codec latency on send) and the
// inline-decoded marker. Our overlay UI only — brand palette (Signal-green), brand type
// (Jost), no emoji.

const STYLE_ID = 'lortnoc-style'
const SIGNAL = '#4ade80'

// Brand font, loaded from the extension's bundled woff2 (web_accessible_resources).
const jostUrl = (w: string): string => chrome.runtime.getURL(`fonts/jost/jost-${w}.woff2`)

export function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    @font-face { font-family:"LortnocJost"; font-weight:300; font-display:swap; src:url("${jostUrl('300')}") format("woff2"); }
    @font-face { font-family:"LortnocJost"; font-weight:400; font-display:swap; src:url("${jostUrl('400')}") format("woff2"); }
    /* decoded text reads as an intentional, clearly-"ours" pill — Signal-green */
    .lortnoc-decoded {
      background: rgba(74,222,128,.11);
      box-shadow: inset 0 -1px 0 rgba(74,222,128,.5);
      border-radius: 3px;
      padding: 0 3px;
      cursor: help;
    }
    /* hover card — appended to <body> with position:fixed so Telegram's overflow
       containers can't clip it (that was the old glitch) */
    .lortnoc-card {
      position: fixed;
      z-index: 2147483647;
      max-width: 340px;
      background: #0b0b0e;
      color: #edeae4;
      border: 1px solid rgba(74,222,128,.4);
      border-radius: 4px;
      padding: 10px 12px;
      font: 300 12px/1.55 "LortnocJost", system-ui, sans-serif;
      box-shadow: 0 12px 34px rgba(0,0,0,.6);
      pointer-events: none;
      opacity: 0;
      transition: opacity .12s ease;
    }
    .lortnoc-card.show { opacity: 1; }
    .lortnoc-card b {
      display: block; margin-bottom: 5px; color: ${SIGNAL}; font-weight: 400;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase;
    }
    /* "working" cue while the codec runs (GPT-2 takes seconds) */
    .lortnoc-busy { opacity: .6; animation: lortnoc-pulse 1.1s ease-in-out infinite; }
    @keyframes lortnoc-pulse { 0%,100% { opacity: .55; } 50% { opacity: .9; } }
    .lortnoc-shuffle { animation: lortnoc-flicker .5s ease-in-out; }
    @keyframes lortnoc-flicker {
      0%,100% { opacity: 1; }
      50%     { opacity: .45; filter: blur(.3px); }
    }
    @media (prefers-reduced-motion: reduce) { .lortnoc-shuffle, .lortnoc-busy { animation: none; } }
  `
  document.documentElement.appendChild(s)
}

export function shuffle(el: HTMLElement): void {
  el.classList.add('lortnoc-shuffle')
  window.setTimeout(() => el.classList.remove('lortnoc-shuffle'), 550)
}

function baseCard(): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:320px;' +
    'background:#0b0b0e;color:#edeae4;border:1px solid rgba(237,234,228,.14);' +
    'border-left:2px solid ' + SIGNAL + ';border-radius:4px;padding:14px 16px;' +
    'font:300 13px/1.55 "LortnocJost",system-ui,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.6)'
  return el
}

/** Small mono eyebrow, brand style. */
function eyebrow(text: string): HTMLElement {
  const e = document.createElement('div')
  e.textContent = text
  e.style.cssText =
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;letter-spacing:.16em;' +
    'text-transform:uppercase;color:' + SIGNAL + ';margin-bottom:7px'
  return e
}

/** Transient status toast (auto-dismisses). Pass an optional mono eyebrow label. */
export function toast(msg: string, ms = 4000, label = 'lortnoc tahc'): void {
  const el = baseCard()
  el.appendChild(eyebrow(label))
  const body = document.createElement('div')
  body.textContent = msg
  el.appendChild(body)
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), ms)
}

/** One-tap Accept prompt for an incoming handshake offer (consent-first, §5.3). */
export function showAcceptBanner(onAccept: () => void): void {
  const el = baseCard()
  el.appendChild(eyebrow('Private session request'))
  const p = document.createElement('div')
  p.textContent = 'Someone here wants to start a private, passphrase-free session with you.'
  p.style.marginBottom = '12px'
  const btn = document.createElement('button')
  btn.textContent = 'Accept & connect'
  btn.style.cssText =
    'background:' + SIGNAL + ';color:#08080a;border:0;border-radius:0;padding:9px 16px;' +
    'font-weight:400;font-size:13px;cursor:pointer;font-family:"LortnocJost",system-ui,sans-serif'
  btn.addEventListener('click', () => {
    el.remove()
    onAccept()
  })
  el.appendChild(p)
  el.appendChild(btn)
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), 30000)
}

/** Hover the decoded text → a floating card shows what Telegram actually stored. */
export function attachCoverCard(el: HTMLElement, cover: string): void {
  let card: HTMLElement | null = null
  const show = (): void => {
    if (card) return
    card = document.createElement('div')
    card.className = 'lortnoc-card'
    const label = document.createElement('b')
    label.textContent = 'What Telegram stored'
    card.appendChild(label)
    card.appendChild(document.createElement('br'))
    card.appendChild(document.createTextNode(cover))
    document.body.appendChild(card)
    const r = el.getBoundingClientRect()
    const w = card.offsetWidth
    card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`
    card.style.top = `${Math.min(r.bottom + 6, window.innerHeight - card.offsetHeight - 8)}px`
    requestAnimationFrame(() => card?.classList.add('show'))
  }
  const hide = (): void => {
    card?.remove()
    card = null
  }
  el.addEventListener('mouseenter', show)
  el.addEventListener('mouseleave', hide)
}
