// Putting COVER text into whatever box the user was in. Only cover text ever goes through here.
//
// Lessons carried over from the X build (extension-x/src/content/compose.ts):
//   * A framework-controlled <textarea> ignores a plain `el.value = x` — React tracks the value
//     through the prototype setter, so we call THAT setter and then fire `input`.
//   * Rich editors (Draft.js, ProseMirror, Lexical) keep their own model; the only write they all
//     honour is a real editing command, so contenteditable goes through execCommand('insertText').
//   * The DOM showing the text is not proof the editor's model took it. We verify by reading back,
//     and on any doubt report failure so the sheet offers "Copy" instead of pretending.

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The editable element the user is in, following focus into open shadow roots. */
export function editableTarget(): HTMLElement | null {
  let el: Element | null = document.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  if (!(el instanceof HTMLElement)) return null
  if (el instanceof HTMLTextAreaElement) return el
  if (el instanceof HTMLInputElement && /^(text|search|url|)$/.test(el.type)) return el
  if (el.isContentEditable) return (el.closest('[contenteditable=""],[contenteditable="true"]') as HTMLElement) ?? el
  return null
}

export function insertCover(el: HTMLElement, text: string): boolean {
  try {
    if (!el.isConnected) return false
    el.focus()
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text)
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return el.value === text
    }
    if (el.isContentEditable) {
      // Replace the box's contents: the whole message was written in the sheet.
      const sel = getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      sel?.removeAllRanges()
      sel?.addRange(range)
      document.execCommand('insertText', false, text)
      return norm(el.innerText) === norm(text)
    }
  } catch {
    /* fall through to failure — the sheet offers Copy */
  }
  return false
}
