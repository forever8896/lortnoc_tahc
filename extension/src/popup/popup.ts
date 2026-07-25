import { LOCAL, SESSION, DEFAULT_CODEC_URL } from '../shared/config'
import { sendToCodec } from '../shared/messages'
import type { HealthData } from '../shared/messages'

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const enabled = byId<HTMLInputElement>('enabled')
const passphrase = byId<HTMLInputElement>('passphrase')
const codecUrl = byId<HTMLInputElement>('codecUrl')
const status = byId<HTMLElement>('status')

function setPill(text: string, kind: 'on' | 'off'): void {
  status.textContent = text
  status.className = 'pill ' + (kind === 'on' ? 'pill-on' : 'pill-off')
}

async function checkHealth(): Promise<void> {
  setPill('checking…', 'off')
  const res = await sendToCodec<HealthData>({ type: 'HEALTH' })
  if (res.ok && res.data.ready) setPill(`codec ok · ${res.data.model}`, 'on')
  else setPill('codec offline', 'off')
}

async function load(): Promise<void> {
  const local = await chrome.storage.local.get([LOCAL.enabled, LOCAL.codecUrl])
  const session = await chrome.storage.session.get(SESSION.passphrase)
  enabled.checked = Boolean(local[LOCAL.enabled])
  codecUrl.value = (local[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  passphrase.value = (session[SESSION.passphrase] as string) || ''
  void checkHealth()
}

async function save(): Promise<void> {
  await chrome.storage.local.set({
    [LOCAL.enabled]: enabled.checked,
    [LOCAL.codecUrl]: codecUrl.value.trim() || DEFAULT_CODEC_URL,
  })
  await chrome.storage.session.set({ [SESSION.passphrase]: passphrase.value })
  void checkHealth()
}

// ---- Tier-1 handshake (no passphrase) ----
const hsStatus = byId<HTMLElement>('hsStatus')

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

/** Find the active Telegram tab; if the content script is orphaned (after an extension
 *  reload), re-inject it so the popup self-heals instead of saying "open a telegram tab". */
async function reachContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'HS_STATUS' })
    return true
  } catch {
    // orphaned/missing — re-inject the content script and retry once
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
  const onTelegram = (tab.url ?? '').includes('web.telegram.org')
  if (!onTelegram) {
    hsStatus.textContent = 'open web.telegram.org/k/'
    hsStatus.className = 'pill pill-off'
    return
  }
  if (!(await reachContentScript(tab.id))) {
    hsStatus.textContent = 'reload the Telegram tab'
    hsStatus.className = 'pill pill-off'
    return
  }
  try {
    const r = (await chrome.tabs.sendMessage(tab.id, { type: 'HS_STATUS' })) as {
      status: string
      hasKey: boolean
      client: string
    }
    if (r?.client && r.client !== 'k') {
      hsStatus.textContent = 'use web.telegram.org/k/'
      hsStatus.className = 'pill pill-off'
      return
    }
    const map: Record<string, string> = {
      none: 'not connected',
      offered: 'invite sent…',
      established: '🔒 connected',
    }
    hsStatus.textContent = map[r?.status] ?? 'not connected'
    hsStatus.className = 'pill ' + (r?.status === 'established' ? 'pill-on' : 'pill-off')
  } catch {
    hsStatus.textContent = 'reload the Telegram tab'
    hsStatus.className = 'pill pill-off'
  }
}

byId('connect').addEventListener('click', async () => {
  const tab = await activeTab()
  if (!tab?.id) return
  if (!(tab.url ?? '').includes('web.telegram.org')) {
    hsStatus.textContent = 'open web.telegram.org/k/'
    return
  }
  await reachContentScript(tab.id) // ensure the content script is alive (re-inject if needed)
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_HANDSHAKE' })
    hsStatus.textContent = 'invite sent…'
    window.close() // let the user watch the chat for the handshake
  } catch {
    hsStatus.textContent = 'reload the Telegram tab'
  }
})

byId('save').addEventListener('click', () => void save())
byId('check').addEventListener('click', () => void checkHealth())
enabled.addEventListener('change', () => void save())
void load()
void refreshHsStatus()
