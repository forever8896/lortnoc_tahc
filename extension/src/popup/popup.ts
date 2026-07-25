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

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id
}

async function refreshHsStatus(): Promise<void> {
  const id = await activeTabId()
  if (id === undefined) return
  try {
    const r = (await chrome.tabs.sendMessage(id, { type: 'HS_STATUS' })) as { status: string; hasKey: boolean }
    const map: Record<string, string> = {
      none: 'not connected',
      offered: 'invite sent…',
      established: '🔒 connected',
    }
    hsStatus.textContent = map[r?.status] ?? 'not connected'
    hsStatus.className = 'pill ' + (r?.status === 'established' ? 'pill-on' : 'pill-off')
  } catch {
    hsStatus.textContent = 'open a Telegram tab'
    hsStatus.className = 'pill pill-off'
  }
}

byId('connect').addEventListener('click', async () => {
  const id = await activeTabId()
  if (id === undefined) return
  try {
    await chrome.tabs.sendMessage(id, { type: 'START_HANDSHAKE' })
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
