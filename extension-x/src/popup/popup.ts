// Popup: the master on/off switch, recipients (which selects the mode), identity unlock, and a
// live codec-health pill.
import { LOCAL, DEFAULT_CODEC_URL } from '../shared/config'
import { sendToCodec } from '../shared/messages'
import type { HealthData } from '../shared/messages'
import { deriveMasterSecret, deriveMessagingKey, toHex } from '../content/crypto'
import { argon2id } from '@noble/hashes/argon2.js'
import { runSelfTest, checkRecipients, type Stage } from './selftest'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const masterSwitch = $<HTMLButtonElement>('masterSwitch')
const masterSub = $<HTMLElement>('masterSub')
const statusChip = $<HTMLElement>('status')
const codecUrl = $<HTMLInputElement>('codecUrl')
const saveBtn = $<HTMLButtonElement>('save')
const checkBtn = $<HTMLButtonElement>('check')
const recipients = $<HTMLInputElement>('recipients')
const modeChip = $<HTMLElement>('modeChip')
const modeNote = $<HTMLElement>('modeNote')
const passphrase = $<HTMLInputElement>('passphrase')
const unlockBtn = $<HTMLButtonElement>('unlock')
const lockBtn = $<HTMLButtonElement>('lock')
const idChip = $<HTMLElement>('idChip')
const pubRow = $<HTMLElement>('pubRow')
const pub = $<HTMLElement>('pub')
const selftestBtn = $<HTMLButtonElement>('selftest')
const selfChip = $<HTMLElement>('selfChip')
const selfOut = $<HTMLElement>('selfOut')
const hintEl = $<HTMLElement>('hint')

/** A single place for "here is what is wrong and what to do about it". */
function hint(msg: string): void {
  hintEl.textContent = msg
  hintEl.hidden = !msg
}

function renderStages(stages: Stage[]): void {
  selfOut.innerHTML = ''
  for (const st of stages) {
    const row = document.createElement('div')
    const name = document.createElement('span')
    name.textContent = st.name
    const detail = document.createElement('span')
    detail.className = st.ok ? 'ok' : 'bad'
    detail.textContent = `${st.ok ? 'ok' : 'FAIL'} · ${st.detail}`
    row.append(name, detail)
    selfOut.appendChild(row)
  }
  selfOut.hidden = stages.length === 0
}

// Must match content/identity.ts exactly — the same passphrase has to produce the same identity
// in both places, and there is no error if it does not: you would simply never decrypt anything.
const KDF = { t: 2, m: 19456, p: 1 }
const SALT = new TextEncoder().encode('lortnoc/x/identity/v1')
const SESSION_KEY = 'identity'

function paintSwitch(on: boolean): void {
  masterSwitch.dataset.on = String(on)
  masterSwitch.setAttribute('aria-pressed', String(on))
  masterSub.textContent = on ? 'on · posts are hidden' : 'off · posting normally'
}

function paintCodec(state: 'ok' | 'off' | 'paused' | 'checking', label?: string): void {
  // `paused` gets its own state rather than folding into ok/offline: it is neither. The codec is
  // reachable and healthy and will still refuse every post, and the fix ("point at a local one")
  // is different from the fix for either neighbour.
  statusChip.className = `chip ${state === 'ok' ? 'chip-on' : state === 'paused' ? 'chip-warn' : 'chip-off'}`
  statusChip.innerHTML = '<i class="led"></i>'
  statusChip.append(
    label ??
      (state === 'ok' ? 'codec ok' : state === 'checking' ? 'checking…' : state === 'paused' ? 'codec paused' : 'codec offline'),
  )
}

function parseHandles(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((h) => h.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean)
}

/** The honest copy differs per mode; PRD §5 forbids a lock on the public one. */
function paintMode(handles: string[]): void {
  if (handles.length) {
    modeChip.className = 'chip chip-on'
    modeChip.textContent = `${handles.length} recipient${handles.length > 1 ? 's' : ''}`
    modeNote.className = 'note note--ok'
    modeNote.innerHTML =
      '<strong>Only these people can read it.</strong> Nobody can tell who they are, or that the ' +
      'post is addressed at all. What stays public: that you posted, when, and how long it was.'
  } else {
    modeChip.className = 'chip chip-off'
    modeChip.textContent = 'public channel'
    modeNote.className = 'note'
    modeNote.innerHTML =
      '<strong>This mode hides, it does not protect.</strong> The key is the same for everyone and ' +
      'ships inside this extension — treat a public-channel post as readable by anyone who cares ' +
      'to look. Posts are public and permanent.'
  }
}

async function paintIdentity(): Promise<void> {
  const got = await chrome.storage.session.get(SESSION_KEY)
  const raw = got[SESSION_KEY] as { pub: string } | undefined
  if (raw) {
    idChip.className = 'chip chip-on'
    idChip.textContent = 'unlocked'
    pub.textContent = `${raw.pub.slice(0, 16)}…`
    pubRow.hidden = false
  } else {
    idChip.className = 'chip chip-off'
    idChip.textContent = 'locked'
    pubRow.hidden = true
  }
}

async function checkHealth(): Promise<void> {
  paintCodec('checking')
  const res = await sendToCodec<HealthData>({ type: 'HEALTH' })
  if (!res.ok) return paintCodec('off')
  // Report what the codec actually said, not what we hoped — the same rule the encode path
  // follows. A paused codec is healthy AND unusable, so it must not read as green.
  if (res.data.paused) {
    paintCodec('paused')
    hint('The hosted codec is paused for the closed alpha. Run a local one and set its URL below — see extension-x/README.md.')
    return
  }
  paintCodec(res.data.ready ? 'ok' : 'off', res.data.ready ? res.data.model : undefined)
  hint('')
}

async function init(): Promise<void> {
  const local = await chrome.storage.local.get([LOCAL.enabled, LOCAL.codecUrl, LOCAL.recipients])
  paintSwitch(local[LOCAL.enabled] === true)
  codecUrl.value = (local[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  const handles = (local[LOCAL.recipients] as string[]) ?? []
  recipients.value = handles.join(', ')
  paintMode(handles)
  await paintIdentity()
  void checkHealth()
}

masterSwitch.addEventListener('click', async () => {
  const next = masterSwitch.dataset.on !== 'true'
  paintSwitch(next)
  await chrome.storage.local.set({ [LOCAL.enabled]: next })
})

// Persist on every edit so the content script and the popup cannot disagree about the mode.
recipients.addEventListener('change', async () => {
  const handles = parseHandles(recipients.value)
  recipients.value = handles.join(', ')
  paintMode(handles)
  await chrome.storage.local.set({ [LOCAL.recipients]: handles })
})

unlockBtn.addEventListener('click', async () => {
  if (!passphrase.value) return
  unlockBtn.disabled = true
  unlockBtn.textContent = 'Deriving…' // Argon2id is ~1s by design
  try {
    const seed = argon2id(new TextEncoder().encode(passphrase.value), SALT, { ...KDF, dkLen: 32 })
    const id = deriveMessagingKey(deriveMasterSecret(seed))
    await chrome.storage.session.set({
      [SESSION_KEY]: { priv: toHex(id.priv), pub: toHex(id.pub) },
    })
    passphrase.value = ''
    await paintIdentity()
  } finally {
    unlockBtn.disabled = false
    unlockBtn.textContent = 'Unlock'
  }
})

lockBtn.addEventListener('click', async () => {
  await chrome.storage.session.remove(SESSION_KEY)
  await paintIdentity()
})

saveBtn.addEventListener('click', async () => {
  const url = codecUrl.value.trim() || DEFAULT_CODEC_URL
  await chrome.storage.local.set({ [LOCAL.codecUrl]: url })
  codecUrl.value = url
  void checkHealth()
})

checkBtn.addEventListener('click', () => void checkHealth())

selftestBtn.addEventListener('click', async () => {
  selftestBtn.disabled = true
  selftestBtn.textContent = 'Running…' // several codec round trips; seconds on gpt2
  selfChip.className = 'chip chip-off'
  selfChip.textContent = 'running'
  try {
    const stages = await runSelfTest()
    // Resolving the configured recipients is part of the diagnosis: it separates "ENS lookup
    // failed" from "the crypto is wrong", which look identical from a failed post.
    const handles = parseHandles(recipients.value)
    if (handles.length) stages.push(...(await checkRecipients(handles)))
    renderStages(stages)
    const bad = stages.filter((s) => !s.ok).length
    selfChip.className = `chip ${bad ? 'chip-bad' : 'chip-on'}`
    selfChip.textContent = bad ? `${bad} failed` : 'all passed'
  } catch (e) {
    renderStages([{ name: 'self-test', ok: false, detail: String(e).slice(0, 60) }])
    selfChip.className = 'chip chip-bad'
    selfChip.textContent = 'errored'
  } finally {
    selftestBtn.disabled = false
    selftestBtn.textContent = 'Run self-test'
  }
})

void init()
