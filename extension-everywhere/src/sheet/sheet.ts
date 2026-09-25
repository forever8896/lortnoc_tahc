// The compose sheet — an extension-origin iframe, so what you type here is invisible to the page.
// It builds a policy from groups (AND of ORs, PRD §16.6), seals the message with shared/webframe,
// has the codec turn the bytes into cover text, and hands ONLY the cover to the content script.
import { sealMessage, presentCover } from '../../../shared/webframe.mjs'
import { honesty } from '../../../shared/policy.mjs'
import { generatePassphrase } from '../../../shared/checks/passphrase.mjs'
import { toB64, fromHex } from '../../../shared/keys.mjs'
import { sw, LOCAL } from '../shared/messages'
import type { EncodeData, ContentToFrame, FrameToContent } from '../shared/messages'

type CheckDraft =
  | { check: 'public' }
  | { check: 'passphrase'; passphrase: string; hint: string }
  | { check: 'recipients'; keys: string }

const LABELS: Record<CheckDraft['check'], string> = {
  public: 'Anyone with the extension',
  passphrase: 'Anyone with the passphrase',
  recipients: 'Named people',
}
const fresh = (check: CheckDraft['check']): CheckDraft =>
  check === 'public' ? { check } : check === 'passphrase' ? { check, passphrase: generatePassphrase(), hint: '' } : { check, keys: '' }

let groups: CheckDraft[][] = [[fresh('public')]]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const msgEl = $<HTMLTextAreaElement>('msg')
const statusEl = $('status')
const toParent = (m: FrameToContent) => parent.postMessage(m, '*') // cover text only — public by design

function setStatus(text: string, kind: '' | 'ok' | 'err' = '') {
  statusEl.textContent = text
  statusEl.className = `status ${kind}`
  fit()
}
/** Grow the iframe to the content; the content script caps it at the viewport and it scrolls. */
const fit = () => requestAnimationFrame(() => toParent({ lortnoc: 'resize', height: document.body.scrollHeight + 2 }))

// ---------------------------------------------------------------------------
// Draft → policy tree
// ---------------------------------------------------------------------------
function leaf(d: CheckDraft) {
  if (d.check === 'public') return { check: 'public' }
  if (d.check === 'passphrase') return { check: 'passphrase', passphrase: d.passphrase, ...(d.hint.trim() ? { hint: d.hint.trim() } : {}) }
  const keys = d.keys.split(/[\s,]+/).filter(Boolean)
  if (!keys.length) throw new Error('Add at least one messaging key for "Named people".')
  return { check: 'recipients', recipients: keys.map((k) => fromHex(k)) }
}
function buildPolicy() {
  const gs = groups.filter((g) => g.length).map((g) => (g.length === 1 ? leaf(g[0]) : { or: g.map(leaf) }))
  if (!gs.length) throw new Error('Choose who can read it.')
  return gs.length === 1 ? gs[0] : { and: gs }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  const root = $('groups')
  root.replaceChildren()
  groups.forEach((g, gi) => {
    if (gi > 0) root.append(Object.assign(document.createElement('div'), { className: 'and', textContent: 'AND' }))
    const box = Object.assign(document.createElement('div'), { className: 'group' })
    const head = Object.assign(document.createElement('div'), { className: 'group-head' })
    const add = document.createElement('select')
    add.innerHTML = `<option value="">+ or…</option>` + Object.entries(LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')
    add.onchange = () => {
      if (add.value) (g.push(fresh(add.value as CheckDraft['check'])), render())
    }
    head.append(Object.assign(document.createElement('span'), { textContent: `Requirement ${gi + 1}` }), add)
    if (groups.length > 1) {
      const rm = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: 'Remove requirement' })
      rm.onclick = () => ((groups = groups.filter((_, i) => i !== gi)), render())
      head.append(rm)
    }
    box.append(head)
    g.forEach((d, ci) => {
      if (ci > 0) box.append(Object.assign(document.createElement('div'), { className: 'or', textContent: 'or' }))
      box.append(checkEl(d, () => {
        g.splice(ci, 1)
        groups = groups.filter((x) => x.length)
        if (!groups.length) groups = [[fresh('public')]]
        render()
      }))
    })
    root.append(box)
  })
  renderHonesty()
  fit()
}

function checkEl(d: CheckDraft, remove: () => void): HTMLElement {
  const el = Object.assign(document.createElement('div'), { className: 'check' })
  const head = Object.assign(document.createElement('div'), { className: 'check-head' })
  const rm = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: 'Remove' })
  rm.onclick = remove
  head.append(Object.assign(document.createElement('span'), { textContent: LABELS[d.check] }), rm)
  el.append(head)
  const fields = Object.assign(document.createElement('div'), { className: 'fields' })
  if (d.check === 'public') {
    fields.append(note('Hidden from people without the tool — not private. Anyone with the extension can read it.'))
  } else if (d.check === 'passphrase') {
    const pw = input(d.passphrase, (v) => ((d.passphrase = v), renderHonesty()))
    const regen = Object.assign(document.createElement('button'), { className: 'btn btn-ghost btn-small', textContent: 'New' })
    regen.onclick = () => ((d.passphrase = generatePassphrase()), (pw.value = d.passphrase))
    const row = Object.assign(document.createElement('div'), { className: 'row' })
    row.append(pw, regen)
    fields.append(row, input(d.hint, (v) => (d.hint = v), 'Hint shown to readers (optional, public)'),
      note('Share the passphrase privately. The generated one is five random words; a guessable one (a name, a place) can be cracked offline by anyone who sees the post.'))
  } else {
    const ta = document.createElement('textarea')
    ta.placeholder = 'Messaging keys (hex), one per line — ENS names come with the ENS update'
    ta.value = d.keys
    ta.style.minHeight = '54px'
    ta.oninput = () => (d.keys = ta.value)
    fields.append(ta, note('Who they are stays hidden; how many is visible.'))
  }
  el.append(fields)
  return el
}
const note = (t: string) => Object.assign(document.createElement('div'), { className: 'small muted', textContent: t })
function input(value: string, on: (v: string) => void, placeholder = '') {
  const i = Object.assign(document.createElement('input'), { type: 'text', value, placeholder })
  i.oninput = () => on(i.value)
  return i
}

function renderHonesty() {
  const root = $('honesty')
  root.replaceChildren()
  let h
  try {
    h = honesty(buildPolicy())
  } catch {
    return
  }
  const chip = (t: string, kind: string) => root.append(Object.assign(document.createElement('span'), { className: `chip ${kind}`, textContent: t }))
  if (h.obfuscationOnly) chip('hidden, not private — anyone with the extension', 'warn')
  else chip('🔒 only who you chose', 'ok')
  if (h.offlineGuessable) chip('passphrase can be guessed offline — use a strong one', 'warn')
  if (!h.obfuscationOnly && !h.gateCanRead) chip('no server can read this', 'ok')
}

// ---------------------------------------------------------------------------
// Seal → encode → insert
// ---------------------------------------------------------------------------
let lastCover = ''
async function go() {
  const text = msgEl.value
  if (!text.trim()) return setStatus('Write something first.', 'err')
  const btn = $<HTMLButtonElement>('go')
  btn.disabled = true
  try {
    setStatus('Locking it…')
    const frame = await sealMessage(text, buildPolicy())
    setStatus('Turning it into ordinary text…')
    const r = await sw<EncodeData>({ type: 'ENCODE', ciphertextB64: toB64(frame) })
    if (!r.ok) throw new Error(r.error)
    const marker = $<HTMLInputElement>('marker').checked
    await chrome.storage.local.set({ [LOCAL.marker]: marker })
    lastCover = presentCover(r.data.coverText, { marker })
    $('cover').textContent = lastCover
    $('result').hidden = false
    fit()
    toParent({ lortnoc: 'insert', text: lastCover })
    // Plaintext is done with: clear it from this frame's memory and DOM.
    msgEl.value = ''
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'err')
  } finally {
    btn.disabled = false
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== parent) return
  const m = e.data as ContentToFrame
  if (m?.lortnoc !== 'inserted') return
  if (m.how === 'field') setStatus('Inserted. Post it the way you normally would.', 'ok')
  else setStatus('Couldn’t write into that box — press Copy, then paste it in.', 'err')
})

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(lastCover)
  setStatus('Copied. Paste it into the box and post.', 'ok')
}
$('close').onclick = () => toParent({ lortnoc: 'close' })
$('addGroup').onclick = () => ((groups.push([fresh('passphrase')]), render()))
$('go').onclick = () => void go()
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toParent({ lortnoc: 'close' })
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void go()
})
if (location.hash === '#nofield') $('nofield').hidden = false
chrome.storage.local.get(LOCAL.marker).then((g) => {
  if (g[LOCAL.marker] === false) $<HTMLInputElement>('marker').checked = false
})
render()
msgEl.focus()
