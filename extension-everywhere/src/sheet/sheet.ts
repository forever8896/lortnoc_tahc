// The compose sheet — an extension-origin iframe, so what you type here is invisible to the page.
// It builds a policy from groups (AND of ORs, PRD §16.6), seals the message with shared/webframe,
// has the codec turn the bytes into cover text, and hands ONLY the cover to the content script.
import { COUNTRIES } from '../shared/countries'
import { presentCover } from '../../../shared/webframe.mjs'
import { sealPost } from '../../../shared/sealed.mjs'
import { honesty } from '../../../shared/policy.mjs'
import { generatePassphrase } from '../../../shared/checks/passphrase.mjs'
import { toB64, fromHex } from '../../../shared/keys.mjs'
import { gateSealer } from '../../../shared/gateclient.mjs'
import { sw, gatePost } from '../shared/messages'
import { contentHash, withAuthor } from '../../../shared/member.mjs'
import { memberships, attestAsMember, ensSpaces, ensKeys } from '../shared/spaces'
import type { EncodeData, ContentToFrame, FrameToContent, GateHealth } from '../shared/messages'

type CheckDraft =
  | { check: 'public' }
  | { check: 'passphrase'; passphrase: string; hint: string }
  | { check: 'recipients'; keys: string }
  | { check: 'after'; when: string }
  | { check: 'human'; preset: 'poh' | 'selfie' | 'identity'; space: string; country?: string }
  | { check: 'nft'; space: string }

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
  : check === 'nft' ? { check, space: '' }
  : { check, keys: '' }

let groups: CheckDraft[][] = [[fresh('public')]]

/** The ready-made choices. Each is only a starting point: "Edit rules" opens it in the builder. */
type Preset = 'public' | 'passphrase' | 'human' | 'human-or-pass' | 'citizens' | 'after' | 'holders' | 'spacehumans' | `space:${string}` | `nft:${string}`
let editing = false
function presetGroups(p: Preset): CheckDraft[][] {
  if (p === 'passphrase') return [[fresh('passphrase')]]
  if (p === 'human') return [[fresh('human')]]
  if (p === 'human-or-pass') return [[fresh('human'), fresh('passphrase')]]
  if (p === 'citizens') return [[{ check: 'human', preset: 'identity', space: '', country: '' }]]
  if (p === 'after') return [[fresh('after')]]
  // any space by name — the field under the dropdown fills it in (yours are suggested)
  if (p === 'holders') return [[{ check: 'nft', space: ensList[0] ? `@${ensList[0]}` : '' }]]
  if (p === 'spacehumans') return [[{ check: 'human', preset: 'poh', space: ensList[0] ? `@${ensList[0]}` : '' }]]
  if (p.startsWith('space:')) return [[{ check: 'human', preset: 'poh', space: p.slice(6) }]]
  if (p.startsWith('nft:')) return [[{ check: 'nft', space: p.slice(4) }]]
  return [[fresh('public')]]
}
/** Spaces you own or joined — offered in the World ID check and for "post as member". */
/** ENS spaces you use (labels) — added in the popup's Settings. */
let ensList: string[] = []
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
  if (d.check === 'human') {
    if (d.preset === 'identity' && !/^[A-Z]{3}$/.test(d.country ?? '')) throw new Error('Choose the country readers must be citizens of.')
    return { check: 'human', preset: d.preset, ...(d.space ? { space: d.space } : {}), ...(d.preset === 'identity' ? { country: d.country } : {}) }
  }
  if (d.check === 'nft') {
    if (!d.space) throw new Error('Pick the ENS space whose NFT readers must hold.')
    return { check: 'nft', space: d.space }
  }
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
// ---------------------------------------------------------------------------
// The rules builder — plain sentences: "Readers must [know the passphrase] or [be a verified human],
// and [wait until …]". Rows are AND, the pills in a row are OR. It opens pre-filled with whatever
// preset was chosen, so a preset is a starting point you can tweak.
// ---------------------------------------------------------------------------
type Rule = 'public' | 'passphrase' | 'human' | 'citizen' | 'member' | 'nft' | 'after' | 'recipients'
const ruleOf = (d: CheckDraft): Rule =>
  d.check === 'human' ? (d.preset === 'identity' ? 'citizen' : d.space ? 'member' : 'human') : d.check
function rules(): [Rule, string, () => CheckDraft][] {
  const firstSpace = ensList[0] ? `@${ensList[0]}` : ''
  return [
    ['passphrase', 'know the passphrase', () => fresh('passphrase')],
    ['human', 'be a verified human (World ID)', () => fresh('human')],
    ['citizen', 'be a citizen of… (passport, World ID)', () => ({ check: 'human', preset: 'identity', space: '', country: '' })],
    ['nft', "hold a space's NFT", () => ({ check: 'nft', space: firstSpace })],
    ['member', 'be a verified human of a space', () => ({ check: 'human', preset: 'poh', space: firstSpace })],
    ['after', 'wait until a date', () => fresh('after')],
    ['public', 'have lortnoc (anyone with it)', () => fresh('public')],
  ]
}
/** A <select> whose first option is the prompt; picking a rule calls `on` with a fresh draft. */
function rulePicker(prompt: string, on: (d: CheckDraft) => void) {
  const sel = Object.assign(document.createElement('select'), { className: 'pick' })
  const rs = rules()
  sel.innerHTML = `<option value="">${prompt}</option>` + rs.map(([k, t]) => `<option value="${k}">${t}</option>`).join('')
  sel.onchange = () => {
    const r = rs.find(([k]) => k === sel.value)
    if (r) on(r[2]())
  }
  return sel
}

/** Nationality picker — World ID Identity Check matches the passport's ISO alpha-3 code. */
function countrySelect(d: Extract<CheckDraft, { check: 'human' }>, id?: string) {
  const c = document.createElement('select')
  if (id) c.id = id
  c.innerHTML = `<option value="">Choose a country…</option>` + COUNTRIES.map(([a, n]) => `<option value="${a}">${n}</option>`).join('')
  c.value = d.country ?? ''
  c.onchange = () => ((d.country = c.value), renderHonesty())
  return c
}

/** Any space by name — no follow list: yours are suggested, any other is checked on ENS as you type. */
function spaceField(d: { space: string }): HTMLElement[] {
  const listId = 'spaceNames'
  if (!document.getElementById(listId)) {
    const dl = Object.assign(document.createElement('datalist'), { id: listId })
    dl.innerHTML = ensList.map((x) => `<option value="${x}">`).join('')
    document.body.append(dl)
  }
  const i = Object.assign(document.createElement('input'), { type: 'text', value: d.space.replace(/^@/, ''), placeholder: 'spacename', size: 12, spellcheck: false })
  i.setAttribute('list', listId)
  const st = Object.assign(document.createElement('span'), { className: 'small' })
  let t: ReturnType<typeof setTimeout> | undefined
  const check = async () => {
    const l = i.value.trim().toLowerCase()
    if (!l) return void (st.textContent = '')
    const r = await sw<{ exists: boolean }>({ type: 'SPACE_INFO', label: l })
    if (l !== i.value.trim().toLowerCase()) return
    st.textContent = !r.ok ? '' : r.data.exists ? '✓' : '✗ no such space'
    st.style.color = r.ok && r.data.exists ? 'var(--signal)' : 'var(--warn)'
  }
  i.oninput = () => {
    d.space = i.value.trim() ? `@${i.value.trim().toLowerCase()}` : ''
    renderHonesty()
    clearTimeout(t)
    t = setTimeout(() => void check(), 400)
  }
  if (d.space) void check()
  return [i, st]
}

/** After a change in the builder the preset name no longer describes it — say so in the dropdown. */
function edited() {
  const who = $<HTMLSelectElement>('who')
  if (!who.querySelector('option[value="own"]')) who.append(new Option('Your own rules', 'own'))
  who.value = 'own'
  render()
}

function render() {
  const root = $('groups')
  root.replaceChildren()
  root.append(Object.assign(document.createElement('div'), { className: 'small muted', textContent: 'Readers must:' }))
  groups.forEach((g, gi) => {
    if (gi > 0) root.append(Object.assign(document.createElement('div'), { className: 'and', textContent: 'and' }))
    const row = Object.assign(document.createElement('div'), { className: 'rule-row' })
    g.forEach((d, ci) => {
      if (ci > 0) row.append(Object.assign(document.createElement('span'), { className: 'or', textContent: 'or' }))
      row.append(pillEl(d, () => {
        g.splice(ci, 1)
        groups = groups.filter((x) => x.length)
        if (!groups.length) groups = [[fresh('public')]]
        edited()
      }))
    })
    row.append(rulePicker('+ or…', (d) => (g.push(d), edited())))
    root.append(row)
  })
  const more = rulePicker('+ and also…', (d) => (groups.push([d]), edited()))
  more.classList.add('more')
  root.append(more)
  renderHonesty()
  fit()
}

/** One rule as a pill: its phrase, the ONE input it needs, and ×. */
function pillEl(d: CheckDraft, remove: () => void): HTMLElement {
  const el = Object.assign(document.createElement('div'), { className: 'pill' })
  const label = (t: string) => Object.assign(document.createElement('span'), { textContent: t })
  const r = ruleOf(d)
  if (d.check === 'public') el.append(label('have lortnoc'))
  else if (d.check === 'passphrase') {
    const i = input(d.passphrase, (v) => ((d.passphrase = v), (i.size = Math.max(12, v.length)), renderHonesty()))
    i.size = Math.max(12, d.passphrase.length)
    const again = Object.assign(document.createElement('button'), { className: 'mini', textContent: '↻', title: 'New random words' })
    again.onclick = () => ((d.passphrase = generatePassphrase()), (i.value = d.passphrase), (i.size = Math.max(12, d.passphrase.length)), renderHonesty())
    const copy = Object.assign(document.createElement('button'), { className: 'mini', textContent: '⧉', title: 'Copy — send it to your readers another way' })
    copy.onclick = () => void navigator.clipboard.writeText(d.passphrase).then(() => (copy.textContent = '✓'))
    el.append(label('know'), i, again, copy)
  } else if (d.check === 'after') {
    const i = Object.assign(document.createElement('input'), { type: 'datetime-local', value: d.when })
    i.oninput = () => ((d.when = i.value), renderHonesty())
    el.append(label('wait until'), i)
  } else if (d.check === 'nft') {
    el.append(label('hold'), ...spaceField(d), label('.space NFT'))
  } else if (d.check === 'human' && r === 'citizen') {
    const c = countrySelect(d)
    el.append(label('be a citizen of'), c)
  } else if (d.check === 'human' && r === 'member') {
    el.append(label('be a verified human of'), ...spaceField(d), label('.space'))
  } else if (d.check === 'human') {
    const sel = document.createElement('select')
    sel.innerHTML = `<option value="poh">verified human</option><option value="selfie">human (Selfie Check)</option>`
    sel.value = d.preset
    sel.onchange = () => ((d.preset = sel.value as 'poh' | 'selfie'), renderHonesty())
    el.append(label('be a'), sel)
  } else if (d.check === 'recipients') {
    const i = input(d.keys, (v) => (d.keys = v), 'messaging keys, comma-separated')
    el.append(label('be one of'), i)
  }
  const rm = Object.assign(document.createElement('button'), { className: 'mini', textContent: '×', title: 'Remove' })
  rm.onclick = remove
  el.append(rm)
  return el
}

/** The whole policy read back as one sentence — what a reader will need, in plain words. */
function summary(): string {
  const fmt = (w: string) => { const t = new Date(w); return Number.isFinite(t.getTime()) ? t.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '…' }
  const phrase = (d: CheckDraft): string => {
    const r = ruleOf(d)
    if (d.check === 'public') return 'have lortnoc'
    if (d.check === 'passphrase') return 'know the passphrase'
    if (d.check === 'after') return `wait until ${fmt(d.when)}`
    if (d.check === 'nft') return `hold ${d.space.replace(/^@/, '') || '…'}.space's NFT`
    if (d.check === 'recipients') return 'are one of the people you named'
    if (d.check === 'human' && r === 'citizen') return `are citizens of ${COUNTRIES.find(([a]) => a === d.country)?.[1] ?? '…'}`
    if (d.check === 'human' && r === 'member') return `are verified humans of ${d.space.replace(/^@/, '') || '…'}.space`
    return 'are verified humans'
  }
  // A group that is ONLY a date reads as "from <date>", not as a thing people must be.
  const dates = groups.filter((g) => g.length && g.every((d) => d.check === 'after')) as Extract<CheckDraft, { check: 'after' }>[][]
  const from = dates.length ? ` from ${dates.map((g) => g.map((d) => fmt(d.when)).join(' or ')).join(' and ')}` : ''
  const parts = groups.filter((g) => g.length && !dates.includes(g as never)).map((g) => g.map(phrase).join(' or '))
  if (!parts.length || (parts.length === 1 && parts[0] === 'have lortnoc')) return `Anyone with lortnoc can read this${from}.`
  return `Readable by people who ${parts.join(', and who ')}${from && ','}${from}.`
}

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
  // The sentence first (what readers need), then ONE honesty note (what it protects against).
  const say = h.obfuscationOnly
    ? 'Hidden, not private — anyone with lortnoc can read it.'
    : h.offlineGuessable
      ? '🔒 Share the passphrase privately. Keep the generated words — a guessable one can be cracked.'
      : h.gateCanRead
        ? '🔒 Locked. The lortnoc gate holds part of the key — add a passphrase if that matters.'
        : '🔒 Only the people you chose can read it.'
  $('honesty').textContent = `${summary()} ${say}`
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
    // every space named in the rules must exist on ENS (and an NFT rule needs its collection set)
    for (const d of groups.flat()) {
      if (d.check === 'nft' && !d.space) throw new Error('Name the space whose NFT readers must hold.')
      if (!('space' in d) || !d.space) continue
      const r = await sw<{ exists: boolean; token: string }>({ type: 'SPACE_INFO', label: d.space })
      if (r.ok && !r.data.exists) throw new Error(`There is no space called ${d.space.slice(1)}.`)
      if (r.ok && d.check === 'nft' && !r.data.token) throw new Error(`${d.space.slice(1)}.space has no NFT collection set.`)
    }
    const policy = buildPolicy()
    let gateSeal
    // Checks whose key share the gate holds. Each must be one this gate actually runs.
    const gated = [...new Set([...JSON.stringify(policy).matchAll(/"check":"(after|human|nft)"/g)].map((m) => m[1]))]
    if (gated.length) {
      const g = await sw<GateHealth>({ type: 'GATE_HEALTH' })
      if (!g.ok) throw new Error(`The gate is unreachable (${g.error}) — needed for timed, World ID and NFT messages.`)
      const missing = gated.filter((c) => !g.data.checks.includes(c))
      if (missing.length) throw new Error(`This gate does not run the ${missing.join(', ')} check.`)
      gateSeal = gateSealer({ gatePub: g.data.pub, post: gatePost })
    }
    let body = text
    const asSpace = ($('signAs') as HTMLInputElement | null)?.checked ? ($('signSpace') as HTMLSelectElement).value : ''
    if (asSpace) {
      setStatus(`Signing as your member name in ${asSpace}…`)
      body = withAuthor(text, { space: asSpace, ...(await attestAsMember(asSpace, contentHash(text))) })
    }
    // Sealed: the post carries no marker and no readable rule — only people whose keys open it will
    // even see that it is a message (shared/sealed.mjs).
    const frame = await sealPost(body, policy, { gateSeal })
    // The author's own passphrases join their keyring, so they still see their own post.
    for (const d of groups.flat()) if (d.check === 'passphrase') void sw({ type: 'KEYRING_ADD_PASS', passphrase: d.passphrase })
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
$('edit').onclick = () => {
  editing = !editing
  renderDetail($<HTMLSelectElement>('who').value as Preset)
}

/** The detail line under the dropdown: only the ONE input the chosen preset needs. */
function renderDetail(p: Preset) {
  const box = $('detail')
  box.replaceChildren()
  $('custom').hidden = !editing
  $('edit').textContent = editing ? 'Done' : 'Edit rules'
  if (editing) render()
  const pass = editing ? undefined : groups.flat().find((d) => d.check === 'passphrase') as Extract<CheckDraft, { check: 'passphrase' }> | undefined
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
  const citizen = editing ? undefined : groups.flat().find((d) => d.check === 'human' && d.preset === 'identity') as Extract<CheckDraft, { check: 'human' }> | undefined
  if (citizen) {
    const row = Object.assign(document.createElement('div'), { className: 'row' })
    row.append(Object.assign(document.createElement('span'), { className: 'small muted', textContent: 'Citizens of' }), countrySelect(citizen, 'country'))
    box.append(row)
  }
  // a space rule (NFT holders / verified humans of a space): the space name, checked on ENS as you type
  const inSpace = editing || !['holders', 'spacehumans'].includes(p) ? undefined
    : groups.flat().find((d) => d.check === 'nft' || (d.check === 'human' && d.preset === 'poh')) as { check: string; space: string } | undefined
  if (inSpace) {
    const row = Object.assign(document.createElement('div'), { className: 'row' })
    const [field, st] = spaceField(inSpace)
    field.id = 'spaceName'
    const lead = Object.assign(document.createElement('span'), { className: 'small muted', textContent: inSpace.check === 'nft' ? 'Holders of' : 'Verified humans of' })
    lead.style.whiteSpace = 'nowrap'
    row.append(lead,
      field, Object.assign(document.createElement('span'), { className: 'small muted', textContent: '.space' }), st)
    box.append(row)
    if (!inSpace.space) setTimeout(() => field.focus(), 0)
  }
  const after = editing ? undefined : groups.flat().find((d) => d.check === 'after') as Extract<CheckDraft, { check: 'after' }> | undefined
  if (after) {
    const i = Object.assign(document.createElement('input'), { type: 'datetime-local', value: after.when, id: 'when' })
    i.oninput = () => ((after.when = i.value), renderHonesty())
    box.append(i)
  }
  // Members may sign ANY post as their pseudonym (so a space owner can see who wrote it and ban
  // them). Shown only to members; defaults to the space of the chosen lock, else the first one.
  const mine = Object.keys(memberOf)
  if (mine.length) {
    const pre = p.startsWith('space:') && memberOf[p.slice(6)] ? p.slice(6) : mine[0]
    const l = Object.assign(document.createElement('label'), { className: 'toggle' })
    l.innerHTML = `<input type="checkbox" id="signAs"> Sign as <select id="signSpace">${mine
      .map((sp) => `<option value="${sp}"${sp === pre ? ' selected' : ''}>${memberOf[sp]} · ${sp}</option>`).join('')}</select>`
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
    ['citizens', 'Citizens of a country (passport, World ID)'],
    ['holders', 'NFT holders of a space…'],
    ['spacehumans', 'Verified humans of a space…'],
    ...ensList.flatMap((x) => [
      [`space:@${x}`, `Verified humans of ${x}.space`],
      [`nft:@${x}`, `NFT holders of ${x}.space`],
    ] as [Preset, string][]),
    ['after', 'Everyone, after a date'],
  ]
  who.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')
  who.onchange = () => {
    who.querySelector('option[value="own"]')?.remove()
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
Promise.all([memberships(), chrome.storage.local.get('lastWho'), ensSpaces(), ensKeys()]).then(([mem, last, ens, keys]) => {
  // Your spaces, with nothing to manage: bought here (keys), joined by reading (memberships), or added.
  ensList = [...new Set([...ens, ...Object.keys(keys), ...Object.keys(mem).filter((k) => k.startsWith('@')).map((k) => k.slice(1))])].sort()
  memberOf = Object.fromEntries(Object.entries(mem).filter(([k, m]) => m.memberId && k.startsWith('@')).map(([k, m]) => [k, m.memberId!]))
  fillPresets()
  const who = $<HTMLSelectElement>('who')
  const want = last.lastWho as string | undefined
  if (want && [...who.options].some((o) => o.value === want)) who.value = want
  groups = presetGroups(who.value as Preset)
  renderDetail(who.value as Preset)
})
msgEl.focus()
