// Outbound: read the compose draft, replace it with cover text, and trigger a real send.
// The critical gotchas (PRD §6): contenteditable must be mutated via execCommand so the
// framework's controlled model updates; a synthetic Enter won't send, so we .click() the
// send button. Swap ONLY at send-time so Telegram's draft autosave never persists text.
import type { TgClient } from './selectors'
import { selectorsFor, activeCompose } from './selectors'
import { shuffle } from './ui'

let swapping = false // guards our own programmatic click from re-entering the interceptor

export function readCompose(el: HTMLElement): string {
  return el.innerText.replace(/ /g, ' ').trim()
}

/** Replace compose content so the app actually sends `text` (not stale model text). */
export function replaceCompose(el: HTMLElement, text: string): void {
  el.focus()
  const selectionOk = (() => {
    try {
      const sel = window.getSelection()
      sel?.selectAllChildren(el)
      return document.execCommand('insertText', false, text)
    } catch {
      return false
    }
  })()
  if (!selectionOk) {
    // fallback: set text + dispatch input so the controlled model rebuilds
    el.innerText = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }
}

function isSendShortcut(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing
}

function visibleSendButton(selector: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(selector))
  return all.find((b) => b.offsetParent !== null) ?? all[0] ?? null
}

/**
 * onSwap(realText) → coverText to send, or null to ABORT the send (fail-closed:
 * never auto-send plaintext when encoding fails).
 */
export type SwapFn = (realText: string) => Promise<string | null>

export function installSendInterceptor(
  client: TgClient,
  isReady: () => boolean,
  onSwap: SwapFn,
): void {
  const sel = selectorsFor(client)
  if (!sel) return

  async function doSwapAndSend(): Promise<void> {
    if (swapping) return
    const input = activeCompose(sel!)
    if (!input) return
    const real = readCompose(input)
    if (!real) return
    swapping = true
    shuffle(input) // immediate feedback while the codec runs
    try {
      const cover = await onSwap(real) // encrypt + /encode
      if (cover == null) return // fail-closed: leave draft, do not send
      replaceCompose(input, cover)
      const btn = visibleSendButton(sel!.sendButton)
      btn?.click() // real send; synthetic Enter would be ignored (isTrusted:false)
    } finally {
      // release after the app has processed the click
      window.setTimeout(() => {
        swapping = false
      }, 50)
    }
  }

  // Enter-to-send (capture phase, so we pre-empt the app's handler).
  document.addEventListener(
    'keydown',
    (e) => {
      if (swapping || !isReady()) return
      const t = e.target as HTMLElement | null
      if (!t || !t.matches?.(sel.composeInput)) return
      if (!isSendShortcut(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void doSwapAndSend()
    },
    true,
  )

  // Click-the-send-button (capture phase). Our own .click() is skipped via `swapping`.
  document.addEventListener(
    'click',
    (e) => {
      if (swapping || !isReady()) return
      const t = e.target as HTMLElement | null
      const btn = t?.closest?.(sel.sendButton)
      if (!btn) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void doSwapAndSend()
    },
    true,
  )
}
