// All Telegram-Web selectors in ONE place (PRD §6). Detect client by URL path and
// fail loudly if a selector resolves null (Telegram builds drift). Web K is supported;
// Web A is stubbed for a graceful "unsupported" message.

export type TgClient = 'k' | 'a' | 'unknown'

export function detectClient(): TgClient {
  const p = location.pathname
  if (p.startsWith('/k')) return 'k'
  if (p.startsWith('/a')) return 'a'
  return 'unknown'
}

type SelSet = {
  composeInput: string
  sendButton: string
  bubblesContainer: string
  bubble: string // any message bubble (in or out) so the sender also sees decoded text
  bubbleText: string
  timeInMessage: string
  midAttr: string
}

// Web K (morethanwords/tweb) — semantic, durable class names.
export const K: SelSet = {
  composeInput: 'div.input-message-input[contenteditable="true"]',
  sendButton: 'button.btn-send',
  bubblesContainer: '.bubbles',
  bubble: '.bubble',
  bubbleText: '.message',
  timeInMessage: '.time',
  midAttr: 'data-mid',
}

// Web A (Ajaxy/telegram-tt) — best-effort; not the supported target yet.
export const A: SelSet = {
  composeInput: '#editable-message-text',
  sendButton: 'button.send',
  bubblesContainer: '.MessageList',
  bubble: '.Message',
  bubbleText: '.text-content',
  timeInMessage: '.MessageMeta',
  midAttr: 'data-message-id',
}

export function selectorsFor(client: TgClient): SelSet | null {
  if (client === 'k') return K
  if (client === 'a') return A
  return null
}

/** Compose box in the ACTIVE, visible chat (multiple exist across chat panes). */
export function activeCompose(sel: SelSet): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(sel.composeInput))
  // the visible one has non-zero layout box
  return all.find((el) => el.offsetParent !== null) ?? all[0] ?? null
}
