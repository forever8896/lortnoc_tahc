import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { BackendProvider } from './lib/ctx'
import { App } from './app'
import { initTheme } from './lib/theme'

// A tab held open across a deploy is holding an index.html that names chunks the new build no
// longer has, so the next lazy import 404s and the click does nothing — "Failed to fetch
// dynamically imported module". Reloading picks up the current index.html and its chunks.
//
// Guarded by sessionStorage so a genuinely missing chunk (a broken deploy, offline) cannot turn
// into a reload loop: one attempt per tab, then the error surfaces normally.
// Time-bounded, not once-per-tab: the entry module always loads fine (it is the LAZY chunk that
// 404s), so a plain "have I reloaded?" flag would be cleared on every reload and loop forever
// against a genuinely missing chunk. A recent reload means the retry already failed.
const RELOAD_KEY = 'lortnoc.chunkReloadAt'
const RELOAD_COOLDOWN_MS = 15_000
window.addEventListener('vite:preloadError', (e) => {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  if (Date.now() - last < RELOAD_COOLDOWN_MS) return // just tried — let the real error through
  e.preventDefault()
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  window.location.reload()
})

// Register the notification-only service worker (app/public/sw.js — it has no fetch handler, so
// it cannot cache a stale chunk into the problem above). Android Chrome will not show a
// notification without a registration, so this has to exist before the first arrival, not at the
// moment we want to notify. Failure is silent and non-fatal: the tab-title badge still works.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('[lortnoc] service worker did not register — notifications fall back to the title badge:', e)
    })
  })
}

// Before the first paint, not in an effect — a theme applied after mount flashes the
// default palette for a frame, which looks exactly like a bug.
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BackendProvider>
      <App />
    </BackendProvider>
  </StrictMode>,
)
