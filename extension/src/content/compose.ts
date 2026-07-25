// Outbound: read the compose draft, replace it with cover text, and trigger a real send.
// The critical gotchas (PRD §6): contenteditable must be mutated via execCommand so the
// framework's controlled model updates; a synthetic Enter won't send, so we .click() the
// send button. Swap ONLY at send-time so Telegram's draft autosave never persists text.
import type { TgClient } from './selectors'
import { selectorsFor, activeCompose } from './selectors'
import { shuffle, createProgress, type Progress } from './ui'

let swapping = false // true from the moment a send is intercepted until the cover is sent
let allowNextClick = false // set right before OUR programmatic send-button click, so it passes through
let activeClient: TgClient | null = null // remembered so sendCoverText() can send on its own

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
export type SwapFn = (realText: string, progress: Progress) => Promise<string | null>

/**
 * Programmatically send an already-encoded cover text (used for handshake offer/ack
 * frames, which are NOT user-typed). Guards so the interceptor doesn't re-encode it.
 */
export async function sendCoverText(coverText: string): Promise<boolean> {
  if (!activeClient) return false
  const sel = selectorsFor(activeClient)
  if (!sel) return false
  const input = activeCompose(sel)
  if (!input) return false
  if (swapping) return false
  swapping = true
  try {
    replaceCompose(input, coverText)
    const btn = visibleSendButton(sel.sendButton)
    if (!btn) return false
    allowNextClick = true
    btn.click()
    window.setTimeout(() => {
      allowNextClick = false
    }, 300)
    return true
  } finally {
    window.setTimeout(() => {
      swapping = false
    }, 100)
  }
}

export function installSendInterceptor(
  client: TgClient,
  isReady: () => boolean,
  onSwap: SwapFn,
): void {
  activeClient = client
  const sel = selectorsFor(client)
  if (!sel) return

  // Assumes `swapping` was already set true synchronously by the caller (so no second
  // send can slip through the async gap while the codec runs — the double-send bug).
  async function doSwapAndSend(): Promise<void> {
    const input = activeCompose(sel!)
    if (!input) {
      swapping = false
      return
    }
    const real = readCompose(input)
    if (!real) {
      swapping = false
      return
    }
    input.classList.add('lortnoc-busy') // persistent "working" cue during the slow codec call
    shuffle(input)
    const progress = createProgress(['Encrypting', 'Weaving cover text', 'Picking the most natural', 'Sending'])
    try {
      const cover = await onSwap(real, progress) // encrypt + /encode (GPT-2 → seconds)
      console.debug('[lortnoc] swap: %o -> %o', real, cover)
      if (cover == null) {
        progress.fail('Encoding failed — not sent')
        return // fail-closed: leave draft, do not send
      }
      replaceCompose(input, cover)
      const btn = visibleSendButton(sel!.sendButton)
      if (!btn) {
        console.warn('[lortnoc] send button not found for', sel!.sendButton)
        progress.fail('Send button not found')
        return
      }
      progress.set(3, 'via Telegram')
      allowNextClick = true
      btn.click() // real send; our click passes the interceptor via allowNextClick
      progress.done('Sent — reads like normal chatter')
      window.setTimeout(() => {
        allowNextClick = false
      }, 300)
    } finally {
      input.classList.remove('lortnoc-busy')
      window.setTimeout(() => {
        swapping = false
      }, 100)
    }
  }

  // Enter-to-send (capture phase). When ready, ALWAYS block the native send — even while a
  // swap is already in flight — so nothing goes out as plaintext during the codec wait.
  document.addEventListener(
    'keydown',
    (e) => {
      const t = e.target as HTMLElement | null
      const onCompose = !!t?.closest?.(sel.composeInput)
      if (!onCompose || !isSendShortcut(e) || !isReady()) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!swapping) {
        swapping = true
        void doSwapAndSend()
      }
    },
    true,
  )

  // Send-button click (capture phase). Let OUR programmatic click through; block user
  // clicks (and start a swap) — including during an in-flight swap.
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement | null
      const btn = t?.closest?.(sel.sendButton)
      if (!btn) return
      if (allowNextClick) {
        allowNextClick = false
        return // our own send — let it fire
      }
      if (!isReady()) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!swapping) {
        swapping = true
        void doSwapAndSend()
      }
    },
    true,
  )
}
