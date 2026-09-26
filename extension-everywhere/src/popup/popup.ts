import { sw, LOCAL, DEFAULT_CODEC_URL } from '../shared/messages'
import type { HealthData } from '../shared/messages'
import { createSpace, ownedSpaces, memberships } from '../shared/spaces'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function health() {
  const h = $('health')
  const r = await sw<HealthData>({ type: 'HEALTH' })
  if (r.ok && r.data.ready && !r.data.paused) (h.textContent = `codec · ${r.data.model}`), (h.className = 'chip ok')
  else (h.textContent = r.ok && r.data.paused ? 'codec paused' : 'codec offline'), (h.className = 'chip warn')
}

async function act(popup: 'compose' | 'scan') {
  const r = await chrome.runtime.sendMessage({ popup })
  if (r?.ok) window.close()
  else $('status').textContent = 'This page can’t be used (browser pages and the Web Store are off-limits).'
}

$('compose').onclick = () => void act('compose')
$('scan').onclick = () => void act('scan')
$('save').onclick = async () => {
  const v = $<HTMLInputElement>('codec').value.trim()
  await chrome.storage.local.set({ [LOCAL.codecUrl]: v || DEFAULT_CODEC_URL })
  void health()
}
chrome.storage.local.get(LOCAL.codecUrl).then((g) => ($<HTMLInputElement>('codec').value = (g[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL))
chrome.commands.getAll().then((cs) => {
  const k = cs.find((c) => c.name === 'compose')?.shortcut
  if (k) $('key').textContent = k
})
void health()

async function renderSpaces() {
  const [own, mem] = await Promise.all([ownedSpaces(), memberships()])
  const rows = [
    ...Object.keys(own).map((s) => `<div>👑 <b>${s}</b> <span class="muted">— you own it</span></div>`),
    ...Object.entries(mem).filter(([s, m]) => m.memberId && !own[s]).map(([s, m]) => `<div>✓ <b>${s}</b> <span class="muted">— ${m.memberId}</span></div>`),
  ]
  $('spaceList').innerHTML = rows.join('') || '<span class="muted">none yet</span>'
}
$('createSpace').onclick = async () => {
  const name = $<HTMLInputElement>('spaceName').value.trim().toLowerCase()
  if (!/^[a-z0-9-]{3,32}$/.test(name)) return void ($('status').textContent = 'Space names are 3–32 of a-z, 0-9 and -.')
  try {
    await createSpace(name)
    $<HTMLInputElement>('spaceName').value = ''
    $('status').textContent = `Created ${name}. Lock posts to "Members of a space" to use it.`
    void renderSpaces()
  } catch (e) {
    $('status').textContent = `Couldn’t create it: ${e instanceof Error ? e.message : e}`
  }
}
void renderSpaces()
