// Client side of the gate: the `deposit` and `release` functions the policy engine calls for
// attested checks. Transport-agnostic — `post(path, body) → json` is supplied by the caller (the
// extension's service worker; an in-process gate in tests), so this is the one implementation.
import { sealTo, openBox, CTX } from './gatebox.mjs'
import { genKeyPair, toHex, fromHex } from './keys.mjs'

/**
 * For compile(): seals each share to the gate and returns the 8-byte reference.
 * @param {{gatePub: string, post: (path: string, body: object) => Promise<any>}} opts
 */
export function gateDepositor({ gatePub, post }) {
  return async (leaf, share, ctx) => {
    const { check, ...params } = leaf
    const r = await post('/deposit', {
      check,
      params,
      box: sealTo(gatePub, share, CTX.deposit),
      policyHash: toHex(ctx.policyHash),
    })
    if (!r?.ref) throw new Error(r?.error ?? 'gate refused the deposit')
    return fromHex(r.ref)
  }
}

/**
 * For open(): asks the gate for a share, sealed to a key generated for this one request.
 * `onDeny(reason)` lets the UI say "opens at …" instead of a bare failure.
 * `proofFor({check, ref, readerPub, policyHash, post})` lets a check attach its proof — World ID asks
 * the gate for a /challenge bound to this post + readerPub, then has the reader prove it.
 * `extraFor(check, params)` adds fields to the release request — a space member's key.
 * `onRelease(response)` sees a successful answer, e.g. `{member: {space, memberId}}` after joining.
 * @param {{post: (path: string, body: object) => Promise<any>, onDeny?: (d: any) => void,
 *          proofFor?: (req: {check: string, ref: string, readerPub: string, policyHash: string,
 *                            post: Function}) => Promise<any>,
 *          extraFor?: (check: string, params: object) => object, onRelease?: (r: any) => void}} opts
 */
export function gateReleaser({ post, onDeny, proofFor, extraFor, onRelease }) {
  return async ({ check, ref, policyHash, params }) => {
    const me = genKeyPair()
    const readerPub = toHex(me.pub)
    const req = { ref: toHex(ref), readerPub, policyHash: toHex(policyHash) }
    let proof
    if (proofFor) {
      try {
        proof = await proofFor({ check, ...req, post })
      } catch (e) {
        onDeny?.({ check, deny: e instanceof Error ? e.message : `proof failed: ${String(e)}` })
        return null
      }
      if (proof === null) return null // the check needs nothing from this reader, or they declined
    }
    const r = await post("/release", { ...req, proof, ...(extraFor ? await extraFor(check, params ?? {}) : {}) })
    if (r?.box) {
      onRelease?.(r)
      return openBox(me.priv, me.pub, r.box, CTX.release)
    }
    onDeny?.({ check, ...(r ?? { deny: 'no answer' }) })
    return null
  }
}

// ---------------------------------------------------------------------------
// Sealed posts (shared/sealed.mjs)
// ---------------------------------------------------------------------------
/**
 * For sealPost(): seals every gate check's share to the gate in ONE request, returns the 8-byte ref.
 * @param {{gatePub: string, post: (path: string, body: object) => Promise<any>}} opts
 */
export function gateSealer({ gatePub, post }) {
  return async (items) => {
    const r = await post('/seal', {
      items: items.map(({ leaf, share }) => {
        const { check, ...params } = leaf
        return { check, params, box: sealTo(gatePub, share, CTX.deposit) }
      }),
    })
    if (!r?.ref) throw new Error(r?.error ?? r?.deny ?? 'the gate refused')
    return fromHex(r.ref)
  }
}

/**
 * Ask the gate about every candidate on a page at once. Unknown refs (not gate posts, or not posts
 * at all) are simply absent from the answer.
 * @returns {Promise<Map<string, {shares: Uint8Array[], members: {space: string, memberId: string}[]}>>}
 *   keyed by hex ref
 */
export async function unlockRefs({ post, token, refs, memberPub }) {
  const me = genKeyPair()
  const r = await post('/unlock', { token, readerPub: toHex(me.pub), refs: refs.map((x) => (typeof x === 'string' ? x : toHex(x))), memberPub })
  const out = new Map()
  for (const it of r?.results ?? []) {
    const shares = (it.boxes ?? []).map((b) => openBox(me.priv, me.pub, b, CTX.release)).filter(Boolean)
    out.set(it.ref, { shares, members: it.members ?? [] })
  }
  return out
}
