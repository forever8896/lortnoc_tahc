import { LOCAL, DEFAULT_CODEC_URL, FREE_LIMIT, WARN_AT, APP_URL, appUrlWithHandle } from '../shared/config'
import { sendToCodec } from '../shared/messages'
import type { HealthData } from '../shared/messages'

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const master = byId<HTMLButtonElement>('masterSwitch')
const masterSub = byId<HTMLElement>('masterSub')
const codecUrl = byId<HTMLInputElement>('codecUrl')
const status = byId<HTMLElement>('status')

let stegoOn = false

function paintMaster(): void {
  master.dataset.on = String(stegoOn)
  master.setAttribute('aria-pressed', String(stegoOn))
  masterSub.textContent = stegoOn ? 'on · hiding your messages' : 'off · sending normally'
  guideState.on = stegoOn
  paintGuide()
}

function setChip(el: HTMLElement, text: string, on: boolean, led = false): void {
  el.className = 'chip ' + (on ? 'chip-on' : 'chip-off')
  el.innerHTML = (led ? '<i class="led"></i>' : '') + text
}

async function checkHealth(): Promise<void> {
  setChip(status, 'checking…', false, true)
  const res = await sendToCodec<HealthData>({ type: 'HEALTH' })
  if (res.ok && res.data.ready) setChip(status, res.data.model ?? 'codec ok', true, true)
  else setChip(status, 'offline', false, true)
  guideState.codec = Boolean(res.ok && res.data.ready)
  paintGuide()
}

// Freemium meter readout — reads the same storage.local the content script writes, so the
// trial state is legible before you ever hit the send-time wall.
const trial = byId<HTMLElement>('trial')
const trialFill = byId<HTMLElement>('trialFill')
const trialLabel = byId<HTMLElement>('trialLabel')
async function paintTrial(): Promise<void> {
  const m = (await chrome.storage.local.get(LOCAL.meter))[LOCAL.meter] as
    | { sends: number; paid: boolean }
    | undefined
  const sends = m?.sends ?? 0
  const paid = Boolean(m?.paid)
  trial.className = 'trial'
  if (paid) {
    trial.classList.add('trial--member')
    trialLabel.textContent = 'member · unlimited'
    return
  }
  const left = Math.max(0, FREE_LIMIT - sends)
  trialFill.style.width = `${Math.min(100, (sends / FREE_LIMIT) * 100)}%`
  if (left === 0) {
    trial.classList.add('trial--spent')
    trialLabel.textContent = 'free trial used — upgrade to keep sending'
  } else if (sends >= WARN_AT) {
    trial.classList.add('trial--low')
    trialLabel.textContent = `${left} of ${FREE_LIMIT} free messages left`
  } else {
    trialLabel.textContent = `${left} of ${FREE_LIMIT} free messages left`
  }
}

// Point the conversion banner at the app, with the Telegram handle prefilled when the content
// script can read it (?handle=), so the claim field on app.lortnoctahc.com is pre-typed.
async function prefillCta(): Promise<void> {
  const cta = document.getElementById('cta') as HTMLAnchorElement | null
  if (!cta) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id || !(tab.url ?? '').includes('web.telegram.org')) return
    if (!(await reachContentScript(tab.id))) return
    const r = (await chrome.tabs.sendMessage(tab.id, { type: 'GET_TG_HANDLE' })) as { handle?: string | null }
    cta.href = appUrlWithHandle(APP_URL, r?.handle)
  } catch {
    /* leave the default app URL (no prefill) */
  }
}


// ---- setup walkthrough ---------------------------------------------------------------------
//
// Four steps, each TICKED BY REAL STATE rather than by the user claiming to have done it. The
// popup already reads all four: codec health, whether the active tab is Telegram Web /k/, the
// stego switch, and the handshake status. Reusing those readings is the whole point — a guide
// that cannot see whether the step worked is a leaflet, and the failure it has to survive is
// someone doing the step and the guide still saying to do it.
//
// Shown until every step is satisfied, then it hides itself and leaves a link to reopen. It is
// NOT shown again automatically once completed: a checklist that reappears every time you open
// the popup is nagging, and by then the popup's own chips report the same state.
const guideEl = byId<HTMLElement>('guide')
const guideNow = byId<HTMLElement>('guideNow')
const guideOpen = byId<HTMLButtonElement>('guideOpen')

type GuideState = { codec: boolean; tab: boolean; on: boolean; hs: boolean }
const guideState: GuideState = { codec: false, tab: false, on: false, hs: false }
/** True once the user has finished or skipped it — kept in storage so it survives the popup. */
let guideDismissed = false

/** What to actually do next, in one line. Written per step because "complete the steps above"
 *  is not guidance. */
const NEXT: Record<keyof GuideState, string> = {
  codec: 'The codec is unreachable — check the URL under Advanced, or your connection.',
  tab: 'Open Telegram Web (/k/) in this tab, then reopen this popup.',
  on: 'Flip PrivacyMaxxing on, below.',
  hs: 'Ask the other person to install this too, then both press Connect securely.',
}
const ORDER: (keyof GuideState)[] = ['codec', 'tab', 'on', 'hs']

function paintGuide(): void {
  const done = ORDER.every((k) => guideState[k])
  // Remember completion the first time it happens. Without this the guide comes BACK the moment
  // a step stops being true — flip PrivacyMaxxing off for one message and a set-up user is shown
  // the beginner checklist again. The chips report that state anyway.
  if (done && !guideDismissed) {
    guideDismissed = true
    void chrome.storage.local.set({ [LOCAL.guideDone]: true })
  }
  // Hidden when finished or skipped; the reopen button takes its place.
  const show = !done && !guideDismissed
  guideEl.hidden = !show
  guideOpen.hidden = show
  guideOpen.textContent = done ? 'Show setup guide' : 'Show setup guide (unfinished)'
  if (!show) return

  const next = ORDER.find((k) => !guideState[k])
  for (const key of ORDER) {
    const li = guideEl.querySelector<HTMLElement>(`.gstep[data-step="${key}"]`)
    if (li) li.dataset.state = guideState[key] ? 'done' : key === next ? 'now' : 'todo'
  }
  guideNow.textContent = next ? NEXT[next] : 'All set — send a message and watch it change.'
}

/** Mark the guide finished so it stops appearing. Called on completion and on skip. */
async function settleGuide(): Promise<void> {
  guideDismissed = true
  await chrome.storage.local.set({ [LOCAL.guideDone]: true })
  paintGuide()
}

byId<HTMLButtonElement>('guideClose').addEventListener('click', () => void settleGuide())
guideOpen.addEventListener('click', () => {
  guideDismissed = false
  paintGuide()
})

async function load(): Promise<void> {
  const local = await chrome.storage.local.get([LOCAL.enabled, LOCAL.codecUrl, LOCAL.guideDone])
  guideDismissed = Boolean(local[LOCAL.guideDone])
  stegoOn = Boolean(local[LOCAL.enabled])
  paintMaster()
  codecUrl.value = (local[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  void checkHealth()
  void paintTrial()
  void prefillCta()
}

async function persist(): Promise<void> {
  await chrome.storage.local.set({
    [LOCAL.enabled]: stegoOn,
    [LOCAL.codecUrl]: codecUrl.value.trim() || DEFAULT_CODEC_URL,
  })
}

master.addEventListener('click', async () => {
  stegoOn = !stegoOn
  paintMaster()
  await persist() // SW picks up the change → toolbar icon lights up green
})

// ---- Tier-1 handshake — the only way a chat is keyed ----
const hsStatus = byId<HTMLElement>('hsStatus')
const fpRow = byId<HTMLElement>('fpRow')
const fp = byId<HTMLElement>('fp')

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

/** Re-inject the content script if it's orphaned (after an extension reload), so the
 *  popup self-heals instead of reporting a dead tab. */
async function reachContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'HS_STATUS' })
    return true
  } catch {
    try {
      const js = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? []
      if (js.length) await chrome.scripting.executeScript({ target: { tabId }, files: js })
      await chrome.tabs.sendMessage(tabId, { type: 'HS_STATUS' })
      return true
    } catch {
      return false
    }
  }
}

async function refreshHsStatus(): Promise<void> {
  const tab = await activeTab()
  if (!tab?.id) return
  if (!(tab.url ?? '').includes('web.telegram.org')) {
    setChip(hsStatus, 'open Telegram', false)
    guideState.tab = false
    guideState.hs = false
    paintGuide()
    return
  }
  if (!(await reachContentScript(tab.id))) {
    setChip(hsStatus, 'reload the tab', false)
    // On the right site but the overlay is not running on it — the step is NOT done, and the
    // guide must not advance to "connect" and send someone hunting for a button that is not there.
    guideState.tab = false
    guideState.hs = false
    paintGuide()
    return
  }
  try {
    const r = (await chrome.tabs.sendMessage(tab.id, { type: 'HS_STATUS' })) as {
      status: string
      hasKey: boolean
      client: string
      fingerprint: string | null
    }
    if (r?.client && r.client !== 'k') {
      setChip(hsStatus, 'use /k/', false)
      guideState.tab = false
      guideState.hs = false
      paintGuide()
      return
    }
    guideState.tab = true
    const map: Record<string, [string, boolean]> = {
      none: ['not connected', false],
      offered: ['invite sent…', false],
      established: ['connected', true],
    }
    const [text, on] = map[r?.status] ?? ['not connected', false]
    setChip(hsStatus, text, on)
    guideState.hs = r?.status === 'established'
    paintGuide()
    paintConnect(r?.status ?? 'none')
    // Only meaningful once a key exists; before that there is nothing to compare.
    fpRow.hidden = !r?.fingerprint
    if (r?.fingerprint) fp.textContent = r.fingerprint.replace(/(..)(?=.)/g, '$1 ').toUpperCase()
    // keep the master-switch sub-label honest: "on" only hides once there's a key
    if (stegoOn) masterSub.textContent = r?.hasKey ? 'on · hiding your messages' : 'on · connect a session first ↓'
  } catch {
    setChip(hsStatus, 'reload the tab', false)
  }
}

// The Connect button IS the interaction sign — its state tells you what's happening so you
// don't click again (the cause of the multi-click keypair churn).
const connectBtn = byId<HTMLButtonElement>('connect')
// True from the click until the offer actually registers, so the 1.5s poll can't briefly
// flip the button back to "Connect securely" mid-send (which would invite the double-click).
let connecting = false
function paintConnect(status: string): void {
  if (status === 'none' && connecting) return // hold the "Sending invite…" state
  connectBtn.classList.remove('is-busy', 'is-done')
  if (status === 'established') {
    connecting = false
    connectBtn.disabled = true
    connectBtn.classList.add('is-done')
    connectBtn.textContent = 'Connected'
  } else if (status === 'offered') {
    connecting = false
    connectBtn.disabled = true
    connectBtn.classList.add('is-busy')
    connectBtn.textContent = 'Invite sent — waiting…'
  } else {
    connectBtn.disabled = false
    connectBtn.textContent = 'Connect securely'
  }
}

connectBtn.addEventListener('click', async () => {
  const tab = await activeTab()
  if (!tab?.id) return
  if (!(tab.url ?? '').includes('web.telegram.org')) {
    setChip(hsStatus, 'open Telegram', false)
    return
  }
  // immediate feedback so nobody clicks twice
  connecting = true
  connectBtn.disabled = true
  connectBtn.classList.add('is-busy')
  connectBtn.textContent = 'Sending invite…'
  await reachContentScript(tab.id)
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_HANDSHAKE' })
    setChip(hsStatus, 'invite sent…', false)
    // keep the popup OPEN and poll — you watch it flip to "Connected" live
  } catch {
    connecting = false
    setChip(hsStatus, 'reload the tab', false)
    paintConnect('none')
  }
})

byId('save').addEventListener('click', () => void persist().then(checkHealth))
byId('check').addEventListener('click', () => void checkHealth())
void load()
void refreshHsStatus()
// poll while the popup is open so the button/status update live as the peer accepts
setInterval(() => {
  void refreshHsStatus()
  void paintTrial()
}, 1500)
