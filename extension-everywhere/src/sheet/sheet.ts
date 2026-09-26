// The compose sheet — an extension-origin iframe, so what you type here is invisible to the page.
// It builds a policy from groups (AND of ORs, PRD §16.6), seals the message with shared/webframe,
// has the codec turn the bytes into cover text, and hands ONLY the cover to the content script.
import { sealMessage, presentCover } from '../../../shared/webframe.mjs'
import { honesty } from '../../../shared/policy.mjs'
import { generatePassphrase } from '../../../shared/checks/passphrase.mjs'
import { toB64, fromHex } from '../../../shared/keys.mjs'
import { gateDepositor } from '../../../shared/gateclient.mjs'
import { sw, gatePost } from '../shared/messages'
import { contentHash, withAuthor } from '../../../shared/member.mjs'
import { ownedSpaces, memberships, attestAsMember } from '../shared/spaces'
import type { EncodeData, ContentToFrame, FrameToContent, GateHealth } from '../shared/messages'

type CheckDraft =
  | { check: 'public' }
  | { check: 'passphrase'; passphrase: string; hint: string }
  | { check: 'recipients'; keys: string }
  | { check: 'after'; when: string }
  | { check: 'human'; preset: 'poh' | 'selfie'; space: string }

const LABELS: Record<CheckDraft['check'], string> = {
  public: 'Anyone with the extension',
  passphrase: 'Anyone with the passphrase',
  recipients: 'Named people',
  after: 'Opens after a time',
  human: 'Verified humans (World ID)',
}
/** datetime-local value for `h` hours from now, in the user's own time zone */
const localIn = (h: number) => {
  const d = new Date(Date.now() + h * 3600_000)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
const fresh = (check: CheckDraft['check']): CheckDraft =>
  check === 'public' ? { check }
  : check === 'passphrase' ? { check, passphrase: generatePassphrase(), hint: '' }
  : check === 'after' ? { check, when: localIn(1) }
  : check === 'human' ? { check, preset: 'poh', space: '' }
  : { check, keys: '' }

let groups: CheckDraft[][] = [[fresh('public')]]

/** The ready-made choices. "custom" reveals the full builder (AND of ORs). */
type Preset = 'public' | 'passphrase' | 'human' | 'human-or-pass' | 'after' | `space:${string}` | 'custom'
function presetGroups(p: Preset): CheckDraft[][] {
  if (p === 'passphrase') return [[fresh('passphrase')]]
  if (p === 'human') return [[fresh('human')]]
  if (p === 'human-or-pass') return [[fresh('human'), fresh('passphrase')]]
  if (p === 'after') return [[fresh('after')]]
  if (p.startsWith('space:')) return [[{ check: 'human', preset: 'poh', space: p.slice(6) }]]
  return [[fresh('public')]]
}
/** Spaces you own or joined — offered in the World ID check and for "post as member". */
let knownSpaces: string[] = []
let memberOf: Record<string, string> = {}

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
  if (d.check === 'human') return { check: 'human', preset: d.preset, ...(d.space ? { space: d.space } : {}) }
  if (d.check === 'after') {
    const t = new Date(d.when).getTime()
    if (!Number.isFinite(t)) throw new Error('Pick when it should open.')
    return { check: 'after', after: t }
  }
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
  } else if (d.check === 'human') {
    const sel = document.createElement('select')
    sel.innerHTML = `<option value="poh">Proof of Human (Orb) — one per person</option><option value="selfie">Selfie Check — keeps bots out</option>`
    sel.value = d.preset
    sel.onchange = () => (d.preset = sel.value as 'poh' | 'selfie')
    const sp = document.createElement('select')
    sp.innerHTML = `<option value="">Any verified human</option>` + knownSpaces.map((x) => `<option value="${x}">Members of ${x}</option>`).join('')
    sp.value = d.space
    sp.onchange = () => (d.space = sp.value)
    fields.append(sel, sp, note('Readers prove they are a unique real person — never who they are, never gender, age or nationality. Keeps bots and sock-puppets out. Add "or passphrase" so people without World ID can still get in.'))
  } else if (d.check === 'after') {
    const i = Object.assign(document.createElement('input'), { type: 'datetime-local', value: d.when })
    i.oninput = () => ((d.when = i.value), renderHonesty())
    fields.append(i, note('Nobody can open it before then — held by the lortnoc gate. Combine with a passphrase so the gate alone can never read it.'))
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
  let h
  try {
    h = honesty(buildPolicy())
  } catch {
    return void ($('honesty').textContent = '')
  }
  // ONE line — the thing that matters most for this choice.
  $('honesty').textContent = h.obfuscationOnly
    ? 'Hidden, not private — anyone with lortnoc can read it.'
    : h.offlineGuessable
      ? '🔒 Share the passphrase privately. Keep the generated words — a guessable one can be cracked.'
      : h.gateCanRead
        ? '🔒 Locked. The lortnoc gate holds part of the key — add a passphrase if that matters.'
        : '🔒 Only the people you chose can read it.'
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
    const policy = buildPolicy()
    let deposit
    const usesGate = /"check":"(after|human)"/.test(JSON.stringify(policy))
    if (usesGate) {
      const g = await sw<GateHealth>({ type: 'GATE_HEALTH' })
      if (!g.ok) throw new Error(`The gate is unreachable (${g.error}) — needed for timed and World ID messages.`)
      if (JSON.stringify(policy).includes('"check":"human"') && !g.data.checks.includes('human'))
        throw new Error('This gate has no World ID configured.')
      deposit = gateDepositor({ gatePub: g.data.pub, post: gatePost })
    }
    let body = text
    const who = $<HTMLSelectElement>('who').value
    const asSpace = who.startsWith('space:') && ($('signAs') as HTMLInputElement | null)?.checked ? who.slice(6) : ''
    if (asSpace) {
      setStatus(`Signing as your member name in ${asSpace}…`)
      body = withAuthor(text, { space: asSpace, ...(await attestAsMember(asSpace, contentHash(text))) })
    }
    const frame = await sealMessage(body, policy, { deposit })
    setStatus('Turning it into ordinary text…')
    const r = await sw<EncodeData>({ type: 'ENCODE', ciphertextB64: toB64(frame) })
    if (!r.ok) throw new Error(r.error)
    // Never tagged: a marker is a "this person is hiding something" flag; readers find posts by
    // deep scan (shape + codec) or right-click Reveal instead.
    lastCover = presentCover(r.data.coverText, { marker: false })
    $('cover').textContent = lastCover
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
  if (m.how === 'field') {
    $('result').hidden = true
    setStatus('Inserted. Post it the way you normally would.', 'ok')
  } else {
    // The hidden text is ready — only the destination is missing. Keep it; don't make them redo it.
    $('result').hidden = false
    setStatus('Click the box you want to post in, then press Insert.', 'err')
  }
})

$('insert').onclick = () => toParent({ lortnoc: 'insert', text: lastCover })
$('copy').onclick = async () => {
  await navigator.clipboard.writeText(lastCover)
  setStatus('Copied. Paste it into the box and post.', 'ok')
}
$('close').onclick = () => toParent({ lortnoc: 'close' })
$('addGroup').onclick = () => ((groups.push([fresh('passphrase')]), render()))

/** The detail line under the dropdown: only the ONE input the chosen preset needs. */
function renderDetail(p: Preset) {
  const box = $('detail')
  box.replaceChildren()
  $('custom').hidden = p !== 'custom'
  if (p === 'custom') return render()
  const pass = groups.flat().find((d) => d.check === 'passphrase') as Extract<CheckDraft, { check: 'passphrase' }> | undefined
  if (pass) {
    const i = Object.assign(document.createElement('input'), { type: 'text', value: pass.passphrase, id: 'pass' })
    i.oninput = () => ((pass.passphrase = i.value), renderHonesty())
    const again = Object.assign(document.createElement('button'), { className: 'btn btn-ghost btn-small', textContent: 'New' })
    again.onclick = () => ((pass.passphrase = generatePassphrase()), (i.value = pass.passphrase))
    const copy = Object.assign(document.createElement('button'), { className: 'btn btn-ghost btn-small', textContent: 'Copy' })
    copy.onclick = () => void navigator.clipboard.writeText(pass.passphrase).then(() => (copy.textContent = 'Copied'))
    const row = Object.assign(document.createElement('div'), { className: 'row' })
    row.append(i, again, copy)
    box.append(row)
  }
  const after = groups.flat().find((d) => d.check === 'after') as Extract<CheckDraft, { check: 'after' }> | undefined
  if (after) {
    const i = Object.assign(document.createElement('input'), { type: 'datetime-local', value: after.when, id: 'when' })
    i.oninput = () => (after.when = i.value)
    box.append(i)
  }
  if (p.startsWith('space:') && memberOf[p.slice(6)]) {
    const l = Object.assign(document.createElement('label'), { className: 'toggle' })
    l.innerHTML = `<input type="checkbox" id="signAs"> Sign as ${memberOf[p.slice(6)]}`
    box.append(l)
  }
  renderHonesty()
  fit()
}

function fillPresets() {
  const who = $<HTMLSelectElement>('who')
  const opts: [Preset, string][] = [
    ['public', 'Anyone with lortnoc'],
    ['passphrase', 'People with the passphrase'],
    ['human', 'Verified humans (World ID)'],
    ['human-or-pass', 'Verified humans, or the passphrase'],
    ...knownSpaces.map((x) => [`space:${x}`, `Members of ${x}`] as [Preset, string]),
    ['after', 'Everyone, after a date'],
    ['custom', 'Custom…'],
  ]
  who.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')
  who.onchange = () => {
    groups = presetGroups(who.value as Preset)
    void chrome.storage.local.set({ lastWho: who.value })
    renderDetail(who.value as Preset)
  }
}
$('go').onclick = () => void go()
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toParent({ lortnoc: 'close' })
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void go()
})
if (location.hash === '#nofield') setStatus('Tip: click the box you want to post in — any time before you press Hide & insert.')
Promise.all([ownedSpaces(), memberships(), chrome.storage.local.get('lastWho')]).then(([own, mem, last]) => {
  knownSpaces = [...new Set([...Object.keys(own), ...Object.keys(mem).filter((k) => mem[k].memberId)])].sort()
  memberOf = Object.fromEntries(Object.entries(mem).filter(([, m]) => m.memberId).map(([k, m]) => [k, m.memberId!]))
  fillPresets()
  const who = $<HTMLSelectElement>('who')
  const want = last.lastWho as string | undefined
  if (want && [...who.options].some((o) => o.value === want)) who.value = want
  groups = presetGroups(who.value as Preset)
  renderDetail(who.value as Preset)
})
msgEl.focus()
