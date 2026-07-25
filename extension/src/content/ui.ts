// Injected styles + the "shuffle" animation (masks codec latency on send) and the
// inline-decoded marker. These touch our own UI only — emoji/markup here is fine
// (it never becomes cover text).

const STYLE_ID = 'lortnoc-style'

export function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    /* decoded text reads as an intentional, clearly-"ours" pill */
    .lortnoc-decoded {
      background: rgba(227,58,32,.12);
      box-shadow: inset 0 -1px 0 rgba(227,58,32,.45);
      border-radius: 4px;
      padding: 0 3px;
      cursor: help;
    }
    .lortnoc-decoded::before { content: "🔓 "; opacity: .7; font-size: .9em; }
    /* hover card — appended to <body> with position:fixed so Telegram's overflow
       containers can't clip it (that was the old glitch) */
    .lortnoc-card {
      position: fixed;
      z-index: 2147483647;
      max-width: 340px;
      background: #14130f;
      color: #efece3;
      border: 1px solid #ff5a3c;
      border-radius: 9px;
      padding: 8px 11px;
      font: 12px/1.5 system-ui, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,.55);
      pointer-events: none;
      opacity: 0;
      transition: opacity .1s ease;
    }
    .lortnoc-card.show { opacity: 1; }
    .lortnoc-card b { color: #ff8a6e; font-weight: 600; }
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

/** Hover the decoded text → a floating card shows what Telegram actually stored. */
export function attachCoverCard(el: HTMLElement, cover: string): void {
  let card: HTMLElement | null = null
  const show = (): void => {
    if (card) return
    card = document.createElement('div')
    card.className = 'lortnoc-card'
    const label = document.createElement('b')
    label.textContent = '🕵 What Telegram stored'
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
