// The reader's keyring — what they have connected, kept only in this extension's storage.
//
// Sealed posts (shared/sealed.mjs) say nothing about what they need, so the extension simply tries
// everything here on every post it finds; posts nothing here opens stay ordinary text.
//   passphrases  — stored as DERIVED keys (passKey), never the words; the label is for the list only
//   token        — the gate session: World ID credentials + wallets proven once (gate/keyring.mjs)
//   readerKey    — X25519 key World ID proofs and wallet signatures are bound to
//   member       — Ed25519 key for "post as my member name" in every space this keyring joins
import { genKeyPair, toHex, fromHex } from '../../../shared/keys.mjs'
import { genSigner } from '../../../shared/member.mjs'

export type Claims = { human: boolean; selfie: boolean; nationalities: string[]; wallets: string[] }
export type Keyring = {
  pass: { id: string; label: string; key: string }[]
  token?: string
  claims?: Claims
  readerKey: { priv: string; pub: string }
  member: { priv: string; pub: string }
}
const KEY = 'keyring'

export async function keyring(): Promise<Keyring> {
  const k = (await chrome.storage.local.get(KEY))[KEY] as Keyring | undefined
  if (k?.readerKey && k?.member) return k
  const kp = genKeyPair()
  const fresh: Keyring = { pass: [], readerKey: { priv: toHex(kp.priv), pub: toHex(kp.pub) }, member: genSigner() }
  await chrome.storage.local.set({ [KEY]: fresh })
  return fresh
}
export async function saveKeyring(k: Keyring) {
  await chrome.storage.local.set({ [KEY]: k })
}
export const passKeys = (k: Keyring) => k.pass.map((p) => fromHex(p.key))
/** "river copper lantern moss eleven" → "river … eleven" — enough to recognise, not to reuse. */
export const labelFor = (passphrase: string) => {
  const w = passphrase.trim().split(/\s+/)
  return w.length > 2 ? `${w[0]} … ${w[w.length - 1]}` : `${passphrase.trim().slice(0, 2)}…`
}
