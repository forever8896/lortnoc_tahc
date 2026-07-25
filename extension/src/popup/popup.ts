import { LOCAL, SESSION, DEFAULT_CODEC_URL } from '../shared/config'
import { sendToCodec } from '../shared/messages'
import type { HealthData } from '../shared/messages'

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const master = byId<HTMLButtonElement>('masterSwitch')
const masterSub = byId<HTMLElement>('masterSub')
const passphrase = byId<HTMLInputElement>('passphrase')
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

async function load(): Promise<void> {
  const local = await chrome.storage.local.get([LOCAL.enabled, LOCAL.codecUrl])
  const session = await chrome.storage.session.get(SESSION.passphrase)
  stegoOn = Boolean(local[LOCAL.enabled])
  paintMaster()
  codecUrl.value = (local[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  passphrase.value = (session[SESSION.passphrase] as string) || ''
  void checkHealth()
}

async function persist(): Promise<void> {
  await chrome.storage.local.set({
    [LOCAL.enabled]: stegoOn,
    [LOCAL.codecUrl]: codecUrl.value.trim() || DEFAULT_CODEC_URL,
  })
  await chrome.storage.session.set({ [SESSION.passphrase]: passphrase.value })
}

master.addEventListener('click', async () => {
  stegoOn = !stegoOn
  paintMaster()
  await persist() // SW picks up the change → toolbar icon lights up green
})

// ---- Tier-1 handshake (no passphrase) ----
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
      established: ['🔒 connected', true],
    }
    const [text, on] = map[r?.status] ?? ['not connected', false]
    setChip(hsStatus, text, on)
  } catch {
    setChip(hsStatus, 'reload the tab', false)
  }
}

byId('connect').addEventListener('click', async () => {
  const tab = await activeTab()
  if (!tab?.id) return
  if (!(tab.url ?? '').includes('web.telegram.org')) {
    setChip(hsStatus, 'open Telegram', false)
    return
  }
  await reachContentScript(tab.id)
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_HANDSHAKE' })
    setChip(hsStatus, 'invite sent…', false)
    window.close()
  } catch {
    setChip(hsStatus, 'reload the tab', false)
  }
})

byId('save').addEventListener('click', () => void persist().then(checkHealth))
byId('check').addEventListener('click', () => void checkHealth())
void load()
void refreshHsStatus()
