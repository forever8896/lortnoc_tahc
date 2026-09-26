// POST /space — turn a `SpaceBought` purchase into `<label>.space.lortnoctahc.eth` on Sepolia.
// The interface contract is docs/PRD-universal.md §23.2; this file is the whole decision, with
// every chain call injected so relayer/test/space.test.mjs can drive it without a network.
//
// What this relayer can and cannot do here, stated plainly:
//   CANNOT invent a space       — no `SpaceBought` event from the pinned LortnocSpaces, nothing to create.
//   CANNOT change the rules     — the buyer committed `rulesHash` on-chain; the token must hash to it.
//   CANNOT redirect a space     — the owner is read from the event, never from the request body.
//   NEVER sends a mainnet tx    — mainnet is only READ (receipt + block height).
//   CAN censor or stall         — accepted, as for /claim.
import { decodeEventLog, keccak256, parseAbiItem, stringToHex } from 'viem'

export const MAINNET = 1
export const SEPOLIA = 11155111

/** Confirmations before a purchase counts (§23.2). */
export const CONFIRMATIONS = { [MAINNET]: 3, [SEPOLIA]: 1 }

export const RULES_PREFIX = 'lortnoc/space/rules/v1|'
/** keccak256(utf8("lortnoc/space/rules/v1|" + token)) — what `buySpace` must have been given. */
export const rulesHashOf = (token) => keccak256(stringToHex(RULES_PREFIX + token))

export const SPACE_BOUGHT = parseAbiItem(
  'event SpaceBought(uint256 indexed id, string label, address indexed spaceOwner, bytes32 rulesHash, address indexed payer, uint256 price)',
)

const LABEL_RE = /^[a-z0-9-]{3,32}$/
/** CAIP-19 ERC-721 collection, or empty for "no token gate". Chain id without leading zeros. */
const TOKEN_RE = /^eip155:[1-9][0-9]{0,15}\/erc721:0x[0-9a-fA-F]{40}$/
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ZERO = '0x0000000000000000000000000000000000000000'

export const validLabel = (l) => typeof l === 'string' && LABEL_RE.test(l) && !l.startsWith('-') && !l.endsWith('-')
export const validToken = (t) => t === '' || (typeof t === 'string' && TOKEN_RE.test(t))

/** Shape-check the request body. Returns `{ ok: true, req }` or `{ ok: false, error }`. */
export function validateSpaceRequest(body) {
  const { chainId, txHash, label, token } = body ?? {}
  if (chainId !== MAINNET && chainId !== SEPOLIA) return { ok: false, error: 'chainId must be 1 or 11155111' }
  if (typeof txHash !== 'string' || !HASH_RE.test(txHash)) return { ok: false, error: 'txHash must be a 32-byte hex hash' }
  if (!validLabel(label)) return { ok: false, error: 'invalid label' }
  if (typeof token !== 'string') return { ok: false, error: 'token must be a string (empty = no token gate)' }
  if (!validToken(token)) return { ok: false, error: 'token must be empty or eip155:<chain>/erc721:<0x address>' }
  return { ok: true, req: { chainId, txHash: txHash.toLowerCase(), label, token } }
}

/** The `SpaceBought` for `label` emitted BY `spacesAddress` in this receipt, or null. A log with the
 *  same topic from any other contract is ignored — anyone can emit that event. */
export function findPurchase(receipt, spacesAddress, label) {
  for (const log of receipt.logs ?? []) {
    if (!log.address || log.address.toLowerCase() !== spacesAddress.toLowerCase()) continue
    let ev
    try {
      ev = decodeEventLog({ abi: [SPACE_BOUGHT], data: log.data, topics: log.topics })
    } catch {
      continue
    }
    if (ev.eventName !== 'SpaceBought' || ev.args.label !== label) continue
    return {
      id: ev.args.id,
      label: ev.args.label,
      owner: ev.args.spaceOwner,
      rulesHash: ev.args.rulesHash,
      payer: ev.args.payer,
      price: ev.args.price,
    }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/**
 * @param {object} deps
 * @param {Record<number, {getTransactionReceipt: Function, getBlockNumber: Function}>} deps.readers  public client per purchase chain
 * @param {Record<number, string>} deps.spaces      LortnocSpaces address per chain (spaces-deployment.json)
 * @param {(label: string) => Promise<string>} deps.spaceOwnerOf   SpaceRegistry.findOwner on Sepolia
 * @param {(label: string, owner: string, token: string) => Promise<string>} deps.claimSpace  claimSpaceFor; resolves to the mined tx hash
 * @param {(owner: string) => Promise<string|null>} [deps.payStipend]  best-effort Sepolia gas
 * @param {(label: string) => Promise<boolean>} [deps.mainnetTaken]  LortnocSpaces.taken on mainnet (guards Sepolia demo buys)
 * @param {string} deps.branchName   `space.lortnoctahc.eth`
 * @param {Function} [deps.log]
 * @param {number} [deps.confirmTimeoutMs]  how long to wait for confirmations inside one request
 * @param {number} [deps.pollMs]
 * @returns {(body: unknown) => Promise<{ status: number, body: object }>}
 */
export function createSpaceHandler(deps) {
  const {
    readers, spaces, spaceOwnerOf, claimSpace, payStipend, mainnetTaken, branchName,
    log = () => {}, confirmTimeoutMs = 120_000, pollMs = 4_000,
  } = deps
  const inFlight = new Set()

  return async function handleSpace(body) {
    const v = validateSpaceRequest(body)
    if (!v.ok) return { status: 400, body: { error: v.error } }
    const { chainId, txHash, label, token } = v.req
    const reader = readers[chainId]
    const spacesAddress = spaces[chainId]
    if (!reader || !spacesAddress) return { status: 400, body: { error: `no LortnocSpaces configured for chain ${chainId}` } }
    if (inFlight.has(label)) return { status: 409, body: { error: 'a claim for this space is in flight' } }
    inFlight.add(label)
    try {
      // 1. The purchase, read from the chain it happened on.
      let receipt
      try {
        receipt = await reader.getTransactionReceipt({ hash: txHash })
      } catch {
        return { status: 404, body: { error: 'transaction not found — not mined yet, or wrong chainId' } }
      }
      if (receipt.status !== 'success') return { status: 400, body: { error: 'the purchase transaction reverted' } }
      const purchase = findPurchase(receipt, spacesAddress, label)
      if (!purchase) {
        return { status: 400, body: { error: 'no SpaceBought for this label from LortnocSpaces in this transaction' } }
      }

      // 2. Its rules are the ones the buyer committed to.
      if (purchase.rulesHash.toLowerCase() !== rulesHashOf(token).toLowerCase()) {
        return { status: 400, body: { error: 'token does not match the rulesHash committed at purchase' } }
      }

      // 3. Confirmations, then re-read: a purchase reorged out while we waited is no purchase.
      const required = BigInt(CONFIRMATIONS[chainId])
      const started = Date.now()
      for (;;) {
        const head = await reader.getBlockNumber()
        const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n
        if (confirmations >= required) break
        if (Date.now() - started >= confirmTimeoutMs) {
          return {
            status: 425,
            body: { error: 'not enough confirmations yet — retry', confirmations: Number(confirmations), required: Number(required) },
          }
        }
        await sleep(pollMs)
      }
      if (required > 1n) {
        const again = await reader.getTransactionReceipt({ hash: txHash }).catch(() => null)
        if (!again || again.blockHash !== receipt.blockHash || again.status !== 'success') {
          return { status: 409, body: { error: 'the purchase was reorganised out — retry once it is re-mined' } }
        }
      }

      // 4. A Sepolia demo purchase must not take a name someone paid real money for on mainnet.
      if (chainId === SEPOLIA && mainnetTaken) {
        let taken
        try {
          taken = await mainnetTaken(label)
        } catch {
          return { status: 503, body: { error: 'cannot check the mainnet purchase contract right now — retry' } }
        }
        if (taken) return { status: 409, body: { error: 'this label was bought on mainnet; a Sepolia purchase cannot claim it' } }
      }

      const name = `${label}.${branchName}`
      const owner = purchase.owner

      // 5. Issue — idempotently. Already ours ⇒ success; anyone else's ⇒ refuse.
      let claimTx = null
      const holder = await spaceOwnerOf(label)
      if (same(holder, owner)) {
        log(`space ${name} already issued to ${owner} — skipping claimSpaceFor`)
      } else if (holder && !same(holder, ZERO)) {
        log(`space ${name} is held by ${holder}, not the buyer ${owner} — refusing`)
        return { status: 409, body: { error: 'space is owned by someone else', name, holder } }
      } else {
        claimTx = await claimSpace(label, owner, token)
        log(`issued ${name} to ${owner} (purchase #${purchase.id} on ${chainId}, ${claimTx})`)
      }

      // 6. Gas for the owner to write bans. Best-effort: the space already exists.
      let stipendTx = null
      if (payStipend) {
        try {
          stipendTx = await payStipend(owner)
        } catch (e) {
          log(`space stipend failed for ${owner}: ${e.shortMessage ?? e.message}`)
        }
      }

      return {
        status: 200,
        body: { name, owner, token, claimTx, stipendTx, chainId, purchaseId: purchase.id.toString() },
      }
    } catch (e) {
      log(`space failed for ${label}: ${e.shortMessage ?? e.message}`)
      return { status: 500, body: { error: String(e.shortMessage ?? e.message ?? e) } }
    } finally {
      inFlight.delete(label)
    }
  }
}
