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
    }
    .lortnoc-decoded::before { content: "🔓 "; opacity: .8; }
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
