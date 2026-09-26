#!/usr/bin/env node
// Local playground for extension-everywhere: a fake recipe page with a WORKING comment section, plus
// the gate, so every feature can be tried by hand without posting anything on a real site.
//
//   node extension-everywhere/playground.mjs          → http://localhost:5190
//
// Comments live in memory (restart = empty page). The codec is whatever the extension popup points
// at — the hosted one by default; the gate runs here on :8790, which is the extension's default.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 5190)
const comments = []
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>Grandma's lentil soup</title>
<style>body{font:18px/1.6 Georgia,serif;max-width:760px;margin:40px auto;padding:0 16px;background:#fdfaf3;color:#222}
.comment{border-top:1px solid #ddd;padding:12px 0}.who{font:600 13px system-ui;color:#886}
textarea{width:100%;font:16px system-ui;padding:8px}button{font:16px system-ui;margin-top:8px;padding:8px 16px}</style></head>
<body><h1>Grandma's lentil soup</h1>
<p>Rinse the lentils, soften an onion with cumin, then simmer everything for forty minutes. Salt at the end.</p>
<h2>Comments (${comments.length})</h2>
${comments.map((c, i) => `<div class="comment"><div class="who">guest #${i + 1}</div><p>${esc(c)}</p></div>`).join('')}
<form method="post" action="/comment"><textarea name="c" rows="4" placeholder="Leave a comment… (click here, then Ctrl+Shift+L)"></textarea><br>
<button>Post comment</button></form>
<form method="post" action="/clear"><button>Clear all comments</button></form></body></html>`

createServer((req, res) => {
  if (req.method === 'POST') {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => {
      if (req.url === '/clear') comments.length = 0
      else {
        const c = new URLSearchParams(b).get('c')?.trim()
        if (c) comments.push(c)
      }
      res.writeHead(303, { location: '/' }).end()
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page())
}).listen(PORT, () => console.log(`playground  http://localhost:${PORT}`))

const gate = spawn(process.execPath, [join(ROOT, 'gate/server.mjs')], { stdio: 'inherit' })
process.on('SIGINT', () => (gate.kill(), process.exit(0)))
