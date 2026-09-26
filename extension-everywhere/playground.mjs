#!/usr/bin/env node
// The lortnoc lab — one local page to try everything by hand.
//
//   npm run lab            (or: node extension-everywhere/playground.mjs)  →  http://localhost:5190
//
// Left: "the site" — an ordinary community board, i.e. what everyone else sees. Posts are saved to
// extension-everywhere/.lab/board.json, so they survive restarts. Right: the lortnoc panel — live
// status of the gate, the codec and World ID, what the gate is, and guided things to try.
//
// It starts the gate (gate/server.mjs, :8790 — the extension's default) unless one is already running.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = Number(process.env.PORT ?? 5190)
const GATE = process.env.GATE_URL ?? 'http://localhost:8790'
const CODEC = process.env.CODEC_URL ?? 'https://lortnoc-codec.fly.dev'
const DATA = join(HERE, '.lab')
const BOARD = join(DATA, 'board.json')

// ---- board storage --------------------------------------------------------------------------------
mkdirSync(DATA, { recursive: true })
let posts = existsSync(BOARD) ? JSON.parse(readFileSync(BOARD, 'utf8')) : []
const save = () => (writeFileSync(BOARD + '.tmp', JSON.stringify(posts, null, 1)), renameSync(BOARD + '.tmp', BOARD))
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString()
}
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
const hue = (n) => [...n].reduce((a, c) => a + c.charCodeAt(0), 0) % 360

// ---- status (fetched server-side, so the page needs no CORS) ----------------------------------------
const stagingUntil = () => {
  try {
    return /^WORLD_STAGING_EXPIRES=(.+)$/m.exec(readFileSync(join(ROOT, 'gate/.env'), 'utf8'))?.[1]?.trim() ?? null
  } catch {
    return null
  }
}
async function status() {
  const get = (u) => fetch(u, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null)
  const [g, c] = await Promise.all([get(`${GATE}/health`), get(`${CODEC}/health`)])
  return {
    gate: g?.ok ? { ok: true, url: GATE, checks: g.checks, world: g.world?.env ?? null, worldEnvs: g.world?.envs ?? [], held: g.deposits ?? [] } : { ok: false, url: GATE },
    codec: c?.ready ? { ok: true, url: CODEC, model: c.model } : { ok: false, url: CODEC },
    stagingUntil: stagingUntil(),
  }
}

// ---- the page ---------------------------------------------------------------------------------------
const page = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lortnoc lab</title>
<style>
@font-face{font-family:Jost;font-weight:300;src:url(/fonts/jost-300.woff2) format("woff2")}
@font-face{font-family:Jost;font-weight:400;src:url(/fonts/jost-400.woff2) format("woff2")}
@font-face{font-family:Jost;font-weight:500;src:url(/fonts/jost-500.woff2) format("woff2")}
:root{--bg:#08080a;--panel:#111116;--ink:#edeae4;--muted:rgba(237,234,228,.6);--faint:rgba(237,234,228,.35);--rule:rgba(237,234,228,.12);
  --signal:#12c4be;--warn:#f0a06a;--bad:#f0806a;--site-bg:#f6f4ef;--site-ink:#1d1d1f;--site-muted:#6b6b70;--site-rule:#e4e1d8;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:grid;grid-template-columns:minmax(0,1fr) 420px;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--site-bg)}
@media (max-width:980px){body{grid-template-columns:1fr}.lab{border-left:0;border-top:1px solid var(--rule)}}

/* ---- the site: deliberately ordinary ---- */
.site{padding:36px clamp(16px,4vw,56px) 80px;color:var(--site-ink);overflow:auto}
.site-top{display:flex;align-items:center;gap:10px;margin-bottom:28px}
.site-logo{width:30px;height:30px;border-radius:8px;background:#e07a3f;display:grid;place-items:center;color:#fff;font-weight:700}
.site-name{font-weight:650}.site-sub{color:var(--site-muted);font-size:13px}
.thread{max-width:720px;margin:0 auto}
.thread h1{font-size:26px;line-height:1.25;margin:0 0 6px}.thread .meta{color:var(--site-muted);font-size:13px;margin-bottom:18px}
.op{background:#fff;border:1px solid var(--site-rule);border-radius:14px;padding:18px 20px;margin-bottom:26px}
.replies-h{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 10px}
.replies-h h2{font-size:15px;margin:0}
.post{display:grid;grid-template-columns:36px 1fr;gap:12px;background:#fff;border:1px solid var(--site-rule);border-radius:14px;padding:14px 16px;margin-bottom:10px}
.av{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:13px;font-weight:600}
.post .who{font-weight:600;font-size:14px}.post .when{color:var(--site-muted);font-size:12px;margin-left:6px;font-weight:400}
.post p{margin:4px 0 0;white-space:pre-wrap;word-wrap:break-word}
.post form{display:inline}.del{background:none;border:0;color:var(--site-muted);font-size:12px;cursor:pointer;float:right}
.empty{color:var(--site-muted);text-align:center;padding:28px;border:1px dashed var(--site-rule);border-radius:14px}
.compose{background:#fff;border:1px solid var(--site-rule);border-radius:14px;padding:14px 16px;margin-top:18px}
.compose input,.compose textarea{width:100%;font:inherit;border:1px solid var(--site-rule);border-radius:10px;padding:10px 12px;background:#fcfbf8;color:var(--site-ink)}
.compose input{max-width:220px;margin-bottom:8px}.compose textarea{min-height:92px;resize:vertical}
.compose textarea:focus,.compose input:focus{outline:2px solid #e07a3f55;border-color:#e07a3f}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:10px}
.btn-site{font:600 14px system-ui;background:#1d1d1f;color:#fff;border:0;border-radius:10px;padding:9px 16px;cursor:pointer}
.link{background:none;border:0;color:var(--site-muted);font-size:13px;cursor:pointer;text-decoration:underline}

/* ---- the lab panel ---- */
.lab{background:var(--bg);color:var(--ink);font:300 14px/1.55 Jost,system-ui,sans-serif;border-left:1px solid var(--rule);overflow:auto;height:100vh;position:sticky;top:0;padding:22px 22px 60px}
.brand{font-weight:500;font-size:18px}.brand b{color:var(--signal);font-weight:500}.brand small{font-family:var(--mono);font-size:10px;letter-spacing:.2em;color:var(--faint);margin-left:8px;text-transform:uppercase}
.eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:22px 0 8px}
.status{display:grid;gap:8px}
.st{display:grid;grid-template-columns:10px 1fr auto;gap:10px;align-items:center;background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:10px 12px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--faint)}.dot.ok{background:var(--signal);box-shadow:0 0 0 4px #12c4be22}.dot.bad{background:var(--bad);box-shadow:0 0 0 4px #f0806a22}.dot.warn{background:var(--warn)}
.st b{font-weight:500}.st .sub{color:var(--muted);font-size:12px}.st code{font-family:var(--mono);font-size:11px;color:var(--faint)}
.fix{grid-column:2/4;font-size:12px;color:var(--warn)}.fix code{color:var(--ink)}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:14px}
.flow{display:grid;gap:10px;margin-top:4px}
.step{display:grid;grid-template-columns:26px 1fr;gap:10px}.n{width:26px;height:26px;border-radius:50%;border:1px solid var(--signal);color:var(--signal);display:grid;place-items:center;font-size:12px;font-weight:500}
.muted{color:var(--muted)}.small{font-size:12.5px}
.try{display:grid;gap:8px}
details.t{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:0}
details.t summary{list-style:none;cursor:pointer;padding:11px 14px;display:flex;justify-content:space-between;gap:8px;align-items:center}
details.t summary::-webkit-details-marker{display:none}
details.t summary .tag{font-family:var(--mono);font-size:10px;color:var(--faint);border:1px solid var(--rule);border-radius:99px;padding:2px 8px;white-space:nowrap}
details.t[open] summary{border-bottom:1px solid var(--rule)}
details.t ol{margin:0;padding:10px 14px 12px 32px}details.t li{margin:3px 0}
kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--rule);border-bottom-width:2px;border-radius:5px;padding:1px 5px;color:var(--ink)}
.q{color:var(--signal)}
.held{display:flex;gap:6px;flex-wrap:wrap}.chip{font-family:var(--mono);font-size:11px;border:1px solid var(--rule);border-radius:99px;padding:3px 9px;color:var(--muted)}
</style></head><body>

<main class="site">
  <div class="site-top"><div class="site-logo">K</div><div><div class="site-name">Kitchen Table</div><div class="site-sub">a community forum · what everyone else sees</div></div></div>
  <div class="thread">
    <h1>Grandma's lentil soup — what do you add?</h1>
    <div class="meta">Posted in Recipes · 128 views</div>
    <div class="op">Rinse the lentils, soften an onion with cumin, then simmer everything for forty minutes. Salt at the end. What's your twist?</div>
    <div class="replies-h"><h2>${posts.length} ${posts.length === 1 ? 'reply' : 'replies'}</h2>
      ${posts.length ? `<form method="post" action="/clear" onsubmit="return confirm('Delete every reply on this board?')"><button class="link">Clear board</button></form>` : ''}</div>
    ${posts.length ? posts.map((p, i) => `<div class="post"><div class="av" style="background:hsl(${hue(p.name)} 45% 45%)">${esc(initials(p.name))}</div>
      <div><form method="post" action="/delete"><input type="hidden" name="i" value="${i}"><button class="del" title="Delete">Delete</button></form>
      <span class="who">${esc(p.name)}</span><span class="when">${ago(p.at)}</span><p>${esc(p.text)}</p></div></div>`).join('')
      : '<div class="empty">No replies yet. Write one — hidden or not.</div>'}
    <form class="compose" method="post" action="/post">
      <input name="name" placeholder="Your name" value="guest" autocomplete="off">
      <textarea name="c" placeholder="Write a reply… — or click here and press Ctrl+Shift+L to write a hidden one"></textarea>
      <div class="row"><span class="site-sub">Plain text only</span><button class="btn-site">Post reply</button></div>
    </form>
  </div>
</main>

<aside class="lab">
  <div class="brand">lortnoc <b>tahc</b><small>lab</small></div>
  <div class="small muted" style="margin-top:4px">Try every feature here without posting anything real. Replies are saved on this machine.</div>

  <div class="eyebrow">Status</div>
  <div class="status" id="status"><div class="st"><span class="dot"></span><span class="sub">checking…</span></div></div>

  <div class="eyebrow">What is the gate?</div>
  <div class="card">
    <div>A small key-holder that runs next to you. It lets a post say <span class="q">“readable after Saturday”</span>, <span class="q">“only verified humans”</span> or <span class="q">“only holders of our NFT”</span> — rules a passphrase alone can't enforce.</div>
    <div class="flow" style="margin-top:12px">
      <div class="step"><span class="n">1</span><div><b>You write.</b> <span class="muted">The extension locks your message and splits the key. The gate gets one piece — never your text.</span></div></div>
      <div class="step"><span class="n">2</span><div><b>You post.</b> <span class="muted">The site only ever sees ordinary-looking words.</span></div></div>
      <div class="step"><span class="n">3</span><div><b>Readers connect their keys once.</b> <span class="muted">World ID · a passport's nationality · a wallet. The post itself never says which it needs.</span></div></div>
      <div class="step"><span class="n">4</span><div><b>The gate hands over its piece to those who qualify.</b> <span class="muted">Their extension opens the message; for everyone else it stays an ordinary reply.</span></div></div>
    </div>
    <div class="small muted" style="margin-top:12px">Honest limit: whoever runs the gate holds that piece. Add a passphrase to a rule and the gate alone can't read it.</div>
    <div class="eyebrow" style="margin-top:14px">It holds right now</div><div class="held" id="held"><span class="chip">—</span></div>
  </div>

  <div class="eyebrow">Try it</div>
  <div class="card small" style="margin-bottom:8px"><b>How reading works now:</b> a hidden reply says nothing about itself — not even that it is a message. Your extension quietly tries <b>your keys</b> on every reply; only replies meant for you get a <b>🔓 Hidden message for you</b> button. Keys live in the extension popup → <b>Your keys</b>. Tip: switch on <b>Always on for localhost</b> there too, and replies are checked on every load.</div>
  <div class="try">
    <details class="t" open><summary><b>1 · Hide a message</b><span class="tag">no setup</span></summary><ol>
      <li>Click the reply box, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>.</li>
      <li>Write your message. <i>Who can read it</i>: <b>Anyone with lortnoc</b>. <b>Hide &amp; insert</b> → <b>Post reply</b>.</li>
      <li>It reads like a normal reply. Extension → <b>Find hidden posts</b>: it is a message for you.</li></ol></details>
    <details class="t"><summary><b>2 · Only people with the passphrase</b><span class="tag">keys</span></summary><ol>
      <li>Pick <b>People with the passphrase</b>, copy the five words, post it. (Your own keyring gets them, so you still see it.)</li>
      <li>Remove them under <b>Your keys</b> → Find hidden posts: the reply is just a reply now. No button, no hint.</li>
      <li>Add the words back → it appears again.</li></ol></details>
    <details class="t"><summary><b>3 · Opens later</b><span class="tag">gate</span></summary><ol>
      <li>Pick <b>Everyone, after a date</b>, two minutes ahead. Post it.</li>
      <li>Until then it is invisible to everyone. After the time, Find hidden posts: there it is.</li></ol></details>
    <details class="t"><summary><b>4 · Only verified humans</b><span class="tag">gate · World ID</span></summary><ol>
      <li>Pick <b>Verified humans (World ID)</b> and post. Without World ID connected, nobody sees it — you neither.</li>
      <li><b>Your keys → World ID → Verified human</b>: World's widget opens; scan with the <b>World ID (Sandbox)</b> app. No phone: <b>Human · simulator</b>.</li>
      <li>Once, not per post. Find hidden posts: every verified-humans reply is there.</li></ol></details>
    <details class="t"><summary><b>5 · Citizens of a country</b><span class="tag">gate · passport</span></summary><ol>
      <li>Pick <b>Citizens of a country</b> → Denmark, post.</li>
      <li><b>Your keys → World ID → Nationality: Denmark → Prove</b>, scan with the Sandbox app (needs a Danish passport there — the simulator can't do passports).</li>
      <li>Danish posts appear; posts for other countries stay invisible.</li></ol></details>
    <details class="t"><summary><b>6 · NFT holders of a space</b><span class="tag">gate · ENS · wallet</span></summary><ol>
      <li>Settings → <b>Buy a space</b> (demo pass on Sepolia) → pick <b>NFT holders of name.space</b>, post.</li>
      <li><b>Your keys → Connect the wallet on this page</b>: one signature, nothing moves. Holders see it; others see a reply.</li>
      <li>On a member-signed reply the owner gets <b>Ban</b> — written to the space's ENS record; the posts vanish for that member.</li></ol></details>
    <details class="t"><summary><b>7 · Mix rules</b><span class="tag">builder</span></summary><ol>
      <li>Any preset → <b>Edit rules</b>: “Readers must [know the passphrase] <b>or</b> [be a verified human] <b>and</b> [wait until …]”.</li>
      <li>The sentence underneath says exactly who will see it.</li></ol></details>
  </div>
</aside>

<script>
const $ = (id) => document.getElementById(id)
const row = (state, title, sub, fix) => '<div class="st"><span class="dot ' + state + '"></span><div><b>' + title + '</b><div class="sub">' + sub + '</div></div><span></span>' + (fix ? '<div class="fix">' + fix + '</div>' : '') + '</div>'
async function refresh() {
  const s = await fetch('/api/status').then((r) => r.json()).catch(() => null)
  if (!s) return
  const g = s.gate, c = s.codec
  const until = s.stagingUntil ? new Date(s.stagingUntil) : null
  const worldOpen = until && until > new Date()
  $('status').innerHTML =
    row(g.ok ? 'ok' : 'bad', 'Gate', g.ok ? 'running · checks: ' + g.checks.join(', ') + ' <code>' + g.url + '</code>' : 'not running <code>' + g.url + '</code>',
      g.ok ? '' : 'Start it: <code>node gate/server.mjs</code> — or restart this lab, which starts it for you.') +
    row(c.ok ? 'ok' : 'bad', 'Codec', c.ok ? 'ready · ' + c.model + ' <code>' + c.url.replace(/^https?:\\/\\//, '') + '</code>' : 'unreachable <code>' + c.url + '</code>',
      c.ok ? '' : 'The extension turns messages into words through it. Check your connection.') +
    (g.ok && g.checks.includes('human')
      ? row(g.world === 'production' || worldOpen ? 'ok' : until ? 'bad' : 'warn', 'World ID',
          (g.world === 'production' ? 'production · real World App' : 'phones: ' + g.world + (g.worldEnvs.includes('staging') && g.world !== 'staging' ? ' · simulator: staging' : '')) + (g.world === 'production' ? '' : worldOpen ? ' · open until ' + until.toLocaleString() : until ? ' · test window CLOSED' : ''),
          g.world !== 'production' && until && !worldOpen ? 'Reopen it: <code>node gate/world-staging-window.mjs</code>' : '')
      : row('warn', 'World ID', 'not configured on this gate', 'Needs gate/.env (WORLD_APP_ID, WORLD_RP_ID, RP_SIGNING_KEY).'))
  $('held').innerHTML = g.ok && g.held.length ? g.held.map((h) => '<span class="chip">' + h.check_id + ' · ' + h.n + '</span>').join('') : '<span class="chip">nothing yet</span>'
}
refresh(); setInterval(refresh, 5000)
</script>
</body></html>`

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(new URLSearchParams(b))) })

createServer(async (req, res) => {
  if (req.method === 'POST') {
    const f = await readBody(req)
    if (req.url === '/clear') posts = []
    else if (req.url === '/delete') posts.splice(Number(f.get('i')), 1)
    else {
      const text = f.get('c')?.trim()
      if (text) posts.push({ name: (f.get('name') ?? '').trim().slice(0, 40) || 'guest', text: text.slice(0, 20_000), at: Date.now() })
    }
    save()
    return res.writeHead(303, { location: '/' }).end()
  }
  if (req.url === '/api/status') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await status()))
  const font = /^\/fonts\/(jost-[345]00\.woff2)$/.exec(req.url ?? '')
  if (font) return res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' }).end(readFileSync(join(HERE, 'public/fonts/jost', font[1])))
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page())
}).listen(PORT, () => console.log(`lortnoc lab  →  http://localhost:${PORT}`))

// The gate: reuse a running one, otherwise start it (and stop it again when the lab stops).
const running = await fetch(`${GATE}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false)
if (running) console.log(`gate         →  ${GATE} (already running — reusing it)`)
else {
  const gate = spawn(process.execPath, [join(ROOT, 'gate/server.mjs')], { stdio: 'inherit' })
  const stop = () => (gate.kill(), process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
