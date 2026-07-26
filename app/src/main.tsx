import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { BackendProvider } from './lib/ctx'
import { App } from './app'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BackendProvider>
      <App />
    </BackendProvider>
  </StrictMode>,
)
