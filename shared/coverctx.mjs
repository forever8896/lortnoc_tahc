// Reply covers (codec2) — what the writer tells the model about the page, and what a reply looks like.
//
// codec2 hides a short LOCATOR in a natural reply; the sealed frame sits in codec2's drop store under
// it. A reply is two parts (codec2/stego.py): an OPENER that answers the conversation and carries no
// bits, then the CARRIER whose context is only the platform plus the opener. So the THREAD (page
// title + the comment being replied to) only shapes how well the opener fits — the reader never
// needs it. Decoding depends on the reply text and the platform alone, which is why a parent edited
// or deleted, a re-sorted thread, a changed title, or the reply seen in a feed changes nothing.

/** hostname → the platform codec2's prompt is shaped for (codec2/stego.py `prompt`). */
export function platformOf(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '')
  if (h === 'reddit.com' || h.endsWith('.reddit.com')) return 'reddit'
  if (h === 'x.com' || h === 'twitter.com' || h.endsWith('.x.com') || h.endsWith('.twitter.com')) return 'x'
  return 'news'
}

export function normaliseTitle(title) {
  return String(title)
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/^\s*\(\d+\+?\)\s*/, '') // "(3) " / "(99+) " unread counters
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * Writer only: what the opener answers. The parent comment is a best-effort guess from the page
 * (content script) — a wrong guess makes a less fitting opener, never an unreadable post.
 * @returns {{thread: string, platform: 'reddit' | 'x' | 'news'}}
 */
export function threadContext(title, host, parent = '') {
  const p = String(parent).normalize('NFKC').replace(/\s+/g, ' ').trim().slice(-400)
  const t = normaliseTitle(title)
  return { thread: p ? `${t}\n\n${p}` : t, platform: platformOf(host) }
}

/** Page text → the exact string the codec emitted (sites only re-wrap whitespace and curl quotes). */
export function replyText(text) {
  return String(text).normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
}

// codec2's character set (codec2/stego.py SAFE): ASCII letters, digits, plain punctuation.
const SAFE = /^[A-Za-z0-9 .,!?'\-:;()/%$&]+$/

/**
 * Could this block be a codec2 reply? One sentence-ending paragraph of 5–80 plain words (opener up
 * to ~25 + carrier up to 45). The model call decides; this only keeps the scan from asking about
 * every block on the page.
 */
export function looksLikeReply(text) {
  const t = replyText(text)
  const words = t.split(' ').filter(Boolean).length
  return words >= 5 && words <= 80 && t.length <= 600 && SAFE.test(t) && /[.!?]$/.test(t) && /^[A-Za-z0-9']/.test(t)
}
