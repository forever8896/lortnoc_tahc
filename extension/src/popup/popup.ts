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

async function load(): Promise<void> {
  const local = await chrome.storage.local.get([LOCAL.enabled, LOCAL.codecUrl])
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
    return
  }
  if (!(await reachContentScript(tab.id))) {
    setChip(hsStatus, 'reload the tab', false)
    return
  }
  try {
    const r = (await chrome.tabs.sendMessage(tab.id, { type: 'HS_STATUS' })) as {
      status: string
      hasKey: boolean
      client: string
    }
    if (r?.client && r.client !== 'k') {
      setChip(hsStatus, 'use /k/', false)
      return
    }
    const map: Record<string, [string, boolean]> = {
      none: ['not connected', false],
      offered: ['invite sent…', false],
      established: ['connected', true],
    }
    const [text, on] = map[r?.status] ?? ['not connected', false]
    setChip(hsStatus, text, on)
    paintConnect(r?.status ?? 'none')
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
