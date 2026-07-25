// Injected styles + the "shuffle" animation (masks codec latency on send) and the
// inline-decoded marker. Our overlay UI only — brand palette (Signal-green), brand type
// (Jost), no emoji.

const STYLE_ID = 'lortnoc-style'
const SIGNAL = '#12c4be'

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
      background: rgba(18, 196, 190,.11);
      box-shadow: inset 0 -1px 0 rgba(18, 196, 190,.5);
      border-radius: 3px;
      padding: 0 3px;
      cursor: help;
    }
    /* inbound "decoding…" cue — dims the cover text + a pulsing teal dot while /decode runs */
    .lortnoc-decoding { opacity: .5; }
    .lortnoc-decoding::after {
      content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 6px;
      border-radius: 50%; background: ${SIGNAL}; vertical-align: baseline;
      animation: lortnoc-pulse .9s ease-in-out infinite;
    }
    /* hover card — appended to <body> with position:fixed so Telegram's overflow
       containers can't clip it (that was the old glitch) */
    .lortnoc-card {
      position: fixed;
      z-index: 2147483647;
      max-width: 340px;
      background: #0b0b0e;
      color: #edeae4;
      border: 1px solid rgba(18, 196, 190,.4);
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
    /* send-progress stepper */
    .lortnoc-prog {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: 272px;
      background: #0b0b0e; border: 1px solid rgba(237,234,228,.14); border-left: 2px solid ${SIGNAL};
      border-radius: 4px; padding: 14px 16px; color: #edeae4;
      font: 300 13px/1.4 "LortnocJost", system-ui, sans-serif;
      box-shadow: 0 14px 40px rgba(0,0,0,.6); transition: opacity .25s ease;
    }
    .lortnoc-prog__eye { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9.5px;
      letter-spacing: .18em; text-transform: uppercase; color: ${SIGNAL}; margin-bottom: 12px; }
    .lortnoc-prog__step { display: flex; align-items: center; gap: 10px; padding: 3px 0;
      color: rgba(237,234,228,.3); transition: color .25s ease; }
    .lortnoc-prog__step[data-s="done"] { color: rgba(237,234,228,.85); }
    .lortnoc-prog__step[data-s="active"] { color: ${SIGNAL}; }
    .lortnoc-prog__step[data-s="fail"] { color: #f0806a; }
    .lortnoc-prog__dot { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid currentColor;
      box-sizing: border-box; flex: 0 0 auto; }
    .lortnoc-prog__step[data-s="done"] .lortnoc-prog__dot { background: ${SIGNAL}; border-color: ${SIGNAL}; }
    .lortnoc-prog__step[data-s="active"] .lortnoc-prog__dot { border-color: ${SIGNAL}; animation: lortnoc-pulse 1s ease-in-out infinite; }
    .lortnoc-prog__sub { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 10px;
      color: rgba(237,234,228,.42); margin: 0 0 4px 19px; }
    .lortnoc-prog__bar { height: 2px; background: rgba(237,234,228,.1); margin-top: 11px; }
    .lortnoc-prog__fill { height: 100%; width: 0; background: ${SIGNAL}; transition: width .5s ease; }
    @media (prefers-reduced-motion: reduce) { .lortnoc-shuffle, .lortnoc-busy { animation: none; } }
  `
  document.documentElement.appendChild(s)
}

export interface Progress {
  /** Mark steps < i as done, step i active (with optional sub-label under it). */
  set(i: number, sub?: string): void
  done(msg?: string): void
  fail(msg: string): void
}

/** A floating stepper that walks a send through its real stages (encrypt → cover → 0G → sent). */
export function createProgress(steps: string[]): Progress {
  const el = document.createElement('div')
  el.className = 'lortnoc-prog'
  const head = document.createElement('div')
  head.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:12px'
  const logo = document.createElement('img')
  logo.src = chrome.runtime.getURL('logo.png')
  logo.style.cssText = 'height:26px;width:auto;display:block;flex:0 0 auto'
  const eye = document.createElement('div')
  eye.className = 'lortnoc-prog__eye'
  eye.style.margin = '0'
  eye.textContent = 'sending privately'
  head.append(logo, eye)
  el.appendChild(head)

  const rows: HTMLElement[] = []
  const subEls: HTMLElement[] = []
  steps.forEach((label) => {
    const row = document.createElement('div')
    row.className = 'lortnoc-prog__step'
    row.dataset.s = 'pending'
    const dot = document.createElement('span')
    dot.className = 'lortnoc-prog__dot'
    const txt = document.createElement('span')
    txt.textContent = label
    row.append(dot, txt)
    el.appendChild(row)
    rows.push(row)
    const sub = document.createElement('div')
    sub.className = 'lortnoc-prog__sub'
    sub.style.display = 'none'
    el.appendChild(sub)
    subEls.push(sub)
  })
  const bar = document.createElement('div')
  bar.className = 'lortnoc-prog__bar'
  const fill = document.createElement('div')
  fill.className = 'lortnoc-prog__fill'
  bar.appendChild(fill)
  el.appendChild(bar)
  document.body.appendChild(el)

  let removed = false
  const remove = (delay: number): void => {
    if (removed) return
    removed = true
    window.setTimeout(() => {
      el.style.opacity = '0'
      window.setTimeout(() => el.remove(), 250)
    }, delay)
  }

  return {
    set(i, sub) {
      rows.forEach((r, k) => (r.dataset.s = k < i ? 'done' : k === i ? 'active' : 'pending'))
      subEls.forEach((s, k) => {
        s.style.display = k === i && sub ? 'block' : 'none'
        if (k === i && sub) s.textContent = sub
      })
      fill.style.width = `${Math.round(((i + 0.5) / steps.length) * 100)}%`
    },
    done(msg) {
      rows.forEach((r) => (r.dataset.s = 'done'))
      subEls.forEach((s) => (s.style.display = 'none'))
      fill.style.width = '100%'
      eye.textContent = msg ?? 'sent'
      remove(1500)
    },
    fail(msg) {
      const active = rows.find((r) => r.dataset.s === 'active')
      if (active) active.dataset.s = 'fail'
      eye.textContent = msg
      remove(3200)
    },
  }
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
