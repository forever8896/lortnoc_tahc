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
 * `proofFor(check, readerPub)` lets a check attach its proof (World ID binds its signal to readerPub).
 * @param {{post: (path: string, body: object) => Promise<any>, onDeny?: (d: any) => void,
 *          proofFor?: (check: string, readerPub: string) => Promise<any>}} opts
 */
export function gateReleaser({ post, onDeny, proofFor }) {
  return async ({ check, ref, policyHash }) => {
    const me = genKeyPair()
    const readerPub = toHex(me.pub)
    const proof = proofFor ? await proofFor(check, readerPub) : undefined
    const r = await post('/release', { ref: toHex(ref), readerPub, policyHash: toHex(policyHash), proof })
    if (r?.box) return openBox(me.priv, me.pub, r.box, CTX.release)
    onDeny?.({ check, ...(r ?? { deny: 'no answer' }) })
    return null
  }
}
