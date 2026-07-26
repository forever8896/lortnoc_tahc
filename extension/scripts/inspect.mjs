#!/usr/bin/env node
// Read what the extension is actually doing inside the paired windows.
//
//   npm run pair:debug        # launch with DevTools endpoints
//   node scripts/inspect.mjs  # attach and report
//
// Console output from the content script is the only place the handshake explains itself, and
// reading it by hand across two windows is how details get missed. This attaches to both, prints
// every [lortnoc] line, and says which chat each window has open — so "is it even running" stops
// being a question you answer by squinting at DevTools.
const PORTS = { alice: 9222, bob: 9223 }
const WINDOW_MS = Number(process.env.WATCH_MS ?? 6000)

async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

/** The Telegram page target (not a worker, not a blob). */
function pageTarget(list) {
  return list.find(
    (t) => t.type === 'page' && t.url.startsWith('https://web.telegram.org/k/') && !t.url.includes('.worker'),
  )
}

async function inspect(name, port) {
  let list
  try {
    list = await targets(port)
  } catch {
    console.log(`\n[${name}] no DevTools endpoint on :${port} — launch with \`npm run pair:debug\``)
    return
  }
  const page = pageTarget(list)
  if (!page) {
    console.log(`\n[${name}] no Telegram page open`)
    return
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const logs = []
  let id = 0
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }))

  await new Promise((resolve) => (ws.onopen = resolve))
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    // Content-script console.* arrives as consoleAPICalled; page errors as Log.entryAdded.
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
      if (text.includes('lortnoc')) logs.push(`  ${m.params.type}: ${text}`)
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry
      if (e.level === 'error' && /ERR_FILE_NOT_FOUND|dynamically imported/.test(e.text)) {
        logs.push(`  \x1b[31mLOAD FAILURE: ${e.text.slice(0, 120)}\x1b[0m`)
      }
    }
  }
  send('Runtime.enable')
  send('Log.enable')

  // Which chat is open, and is our UI present? Runs in the page world — it cannot see content
  // script internals, only what they put in the DOM.
  send('Runtime.evaluate', {
    expression: `JSON.stringify({
      chat: location.hash || '(none)',
      bubbles: !!document.querySelector('.bubbles'),
      compose: !!document.querySelector('div.input-message-input[contenteditable="true"]'),
      lortnocUi: !!document.querySelector('[class*="lortnoc"], #lortnoc-toast, .lortnoc-banner'),
    })`,
    returnByValue: true,
  })

  const state = await new Promise((resolve) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.result?.result?.value) {
        ws.removeEventListener('message', onMsg)
        resolve(JSON.parse(m.result.result.value))
      }
    }
    ws.addEventListener('message', onMsg)
    setTimeout(() => resolve(null), 3000)
  })

  console.log(`\n[${name}] ${page.title}`)
  if (state) {
    console.log(`  chat: ${state.chat}`)
    console.log(`  chat DOM present: bubbles=${state.bubbles} compose=${state.compose}`)
  }

  console.log(`  watching console for ${WINDOW_MS / 1000}s…`)
  await new Promise((r) => setTimeout(r, WINDOW_MS))
  ws.close()

  if (logs.length === 0) {
    console.log('  no [lortnoc] output in this window.')
    console.log('  (the "content script ready" line is logged once at load — reload the tab to see it)')
  } else {
    logs.forEach((l) => console.log(l))
  }
}

for (const [name, port] of Object.entries(PORTS)) await inspect(name, port)
console.log()
