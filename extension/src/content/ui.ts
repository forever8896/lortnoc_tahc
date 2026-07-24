// Injected styles + the "shuffle" animation (masks codec latency on send) and the
// inline-decoded marker. These touch our own UI only — emoji/markup here is fine
// (it never becomes cover text).

const STYLE_ID = 'lortnoc-style'

export function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    .lortnoc-decoded {
      border-bottom: 1px dashed rgba(227,58,32,.7);
      padding-bottom: 1px;
      position: relative;
      cursor: help;
    }
    .lortnoc-decoded::before { content: "🔓 "; opacity: .8; }
    /* hover shows the cover text Telegram actually stores */
    .lortnoc-decoded:hover::after {
      content: "🔒 Telegram sees: " attr(data-cover);
      position: absolute;
      left: 0;
      top: 1.7em;
      z-index: 2147483647;
      min-width: 220px;
      max-width: 340px;
      white-space: normal;
      background: #14130f;
      color: #efece3;
      border: 1px solid #ff5a3c;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 400;
      line-height: 1.4;
      box-shadow: 0 6px 22px rgba(0,0,0,.5);
      pointer-events: none;
    }
    .lortnoc-shuffle { animation: lortnoc-flicker .5s ease-in-out; }
    @keyframes lortnoc-flicker {
      0%,100% { opacity: 1; }
      50%     { opacity: .45; filter: blur(.3px); }
    }
    @media (prefers-reduced-motion: reduce) { .lortnoc-shuffle { animation: none; } }
  `
  document.documentElement.appendChild(s)
}

export function shuffle(el: HTMLElement): void {
  el.classList.add('lortnoc-shuffle')
  window.setTimeout(() => el.classList.remove('lortnoc-shuffle'), 550)
}
