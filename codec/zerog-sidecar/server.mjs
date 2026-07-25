// 0G Compute testnet sidecar. Exposes a tiny local HTTP surface the Python codec calls;
// under the hood it uses the 0G broker SDK to run inference on TESTNET (evmrpc-testnet.0g.ai,
// chain 16602), paid from a faucet-funded ledger. The codec sends candidate cover texts;
// this asks a 0G-hosted model which reads most natural and returns the index.
//
// Env:
//   ZG_PRIVATE_KEY   testnet wallet private key (funded via faucet; NOT an identity wallet)
//   ZG_PROVIDER      provider address for the judge model (see README; default = Qwen2.5-7B)
//   ZG_RPC           default https://evmrpc-testnet.0g.ai
//   PORT             default 8090
//
// Endpoints:
//   GET  /health              -> { ready, provider, model, balance }
//   POST /select {covers:[]}  -> { index }   (which cover reads most natural)
import http from 'node:http'
import { ethers } from 'ethers'
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker'

const RPC = process.env.ZG_RPC || 'https://evmrpc-testnet.0g.ai'
const PORT = Number(process.env.PORT || 8090)
const PK = process.env.ZG_PRIVATE_KEY || ''
// Qwen2.5-7B-Instruct testnet provider (from the 0G starter kit service list):
const PROVIDER = process.env.ZG_PROVIDER || '0xa48f01287233509FD694a22Bf840225062E67836'
const LEDGER_MIN = 3 // OG; ledger setup minimum in broker v0.6.x

let broker = null
let modelName = null
let endpoint = null

async function init() {
  if (!PK) throw new Error('ZG_PRIVATE_KEY not set')
  const wallet = new ethers.Wallet(PK, new ethers.JsonRpcProvider(RPC))
  broker = await createZGComputeNetworkBroker(wallet)
  // ensure a funded ledger (idempotent-ish; ignore "already exists")
  try {
    await broker.ledger.addLedger(LEDGER_MIN)
  } catch (e) {
    if (!String(e).match(/exist|already/i)) console.warn('addLedger:', String(e))
  }
  await broker.inference.acknowledgeProviderSigner(PROVIDER)
  const meta = await broker.inference.getServiceMetadata(PROVIDER)
  endpoint = meta.endpoint
  modelName = meta.model
  console.log(`[zerog] ready — provider ${PROVIDER} model ${modelName} @ ${endpoint}`)
}

async function chat(prompt) {
  const headers = await broker.inference.getRequestHeaders(PROVIDER, prompt)
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 4,
    }),
  })
  if (!res.ok) throw new Error(`inference ${res.status}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

function selectPrompt(covers) {
  const numbered = covers.map((c, i) => `${i + 1}. ${c}`).join('\n')
  return (
    'Below are casual text messages someone might send a friend. Choose the ONE that ' +
    'reads most like a natural, coherent human message. Reply with ONLY its number.\n\n' +
    numbered
  )
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  try {
    if (req.method === 'GET' && req.url === '/health') {
      let balance = null
      try {
        const l = await broker.ledger.getLedger()
        balance = l?.balance?.toString?.() ?? null
      } catch {}
      return json(200, { ready: !!broker, provider: PROVIDER, model: modelName, balance })
    }
    if (req.method === 'POST' && req.url === '/select') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { covers } = JSON.parse(body || '{}')
      if (!Array.isArray(covers) || covers.length < 2) return json(400, { error: 'need >=2 covers' })
      const txt = await chat(selectPrompt(covers))
      const m = txt.match(/\d+/)
      const idx = m ? Math.min(Math.max(parseInt(m[0], 10) - 1, 0), covers.length - 1) : 0
      return json(200, { index: idx })
    }
    json(404, { error: 'not found' })
  } catch (e) {
    json(500, { error: String(e) })
  }
})

init()
  .then(() => server.listen(PORT, () => console.log(`[zerog] sidecar on :${PORT}`)))
  .catch((e) => {
    console.error('[zerog] init failed:', String(e))
    process.exit(1)
  })
