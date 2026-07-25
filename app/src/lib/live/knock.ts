// Knock — challenge-gated contact (CLAUDE.md §6.8).
//
// Nobody can even *notify* you of intent-to-connect unless they clear a gate you set. You publish
// a question; the answer is never published, never sent, and never stored anywhere.
//
//   1. You publish  eth.lortnoc.knock = { prompt, salt, kdf }   — the QUESTION only
//   2. A stranger derives  k = Argon2id(answer, salt)  and sends  AEAD(k, {pubkey, intro})
//   3. You derive k from the answer YOU know and try to open each incoming knock.
//      Auth tag verifies ⇒ "X wants to connect", and their pubkey arrives with it.
//      Auth tag fails    ⇒ silently dropped. You are never even told it happened.
//
// Two properties fall out of this shape:
//
//   * No public commitment to the answer exists anywhere, so there is nothing to brute-force
//     offline. Guessing is online-only, and the relay rate-limits it.
//   * The knock IS the key exchange — a successful one carries the sender's X25519 key, so
//     accepting bootstraps K_conv in the same step (§5.3).
//
// Honest limit: trivia is low-entropy. This is spam-resistance and intentional contact, NOT
// cryptographic access control. Argon2id and rate-limiting slow guessing; they do not stop a
// determined attacker who knows you. For real secrecy, use a high-entropy shared password.
import { argon2id } from '@noble/hashes/argon2.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { fromHex, toHex } from '../crypto'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** RFC 9106's second recommended profile: 19 MiB, t=2, p=1. ~0.9s in a browser — slow enough to
 *  make online guessing expensive, fast enough that a human waits for it once. */
export const DEFAULT_KDF = { t: 2, m: 19456, p: 1 } as const

export type KnockKdf = { t: number; m: number; p: number }

/** What gets published to `eth.lortnoc.knock`. Contains the question and NEVER the answer. */
export type KnockConfig = {
  v: 1
  prompt: string
  /** Hex, 16 bytes. Public — its job is domain separation, not secrecy. */
  salt: string
  kdf: KnockKdf
}

/** What a sender seals inside the knock. Only a correct answer reveals any of it. */
export type KnockPayload = {
  v: 1
  /** The sender's X25519 messaging key — this is what makes the knock a key exchange. */
  pubkey: string
  /** Their handle, if they have one. Optional: you can knock anonymously. */
  from?: string
  intro: string
  ts: number
}

/** Build a fresh config for a question. The answer is used once, here, and then forgotten. */
export function createKnockConfig(prompt: string, kdf: KnockKdf = DEFAULT_KDF): KnockConfig {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { v: 1, prompt: prompt.trim(), salt: toHex(salt), kdf }
}

export function parseKnockConfig(raw: string | null): KnockConfig | null {
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as KnockConfig
    if (c.v !== 1 || !c.prompt || !c.salt || !c.kdf) return null
    return c
  } catch {
    return null
  }
}

/**
 * The whole security budget of this feature sits in this function.
 *
 * Answers are normalised first — lowercased, whitespace collapsed, surrounding punctuation
 * dropped — because "The Blue Door", "blue door" and "the blue door!" are the same answer to a
 * human, and a gate that rejects them is a gate nobody gets through.
 */
export async function deriveKnockKey(answer: string, config: KnockConfig): Promise<Uint8Array> {
  const normalised = normaliseAnswer(answer)
  if (!normalised) throw new Error('answer is empty')
  return argon2id(enc.encode(normalised), fromHex(config.salt), {
    t: config.kdf.t,
    m: config.kdf.m,
    p: config.kdf.p,
    dkLen: 32,
  })
}

export function normaliseAnswer(answer: string): string {
  return answer
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/** Seal a knock. The nonce is random and prepended; the relay sees only this blob. */
export function sealKnock(key: Uint8Array, payload: KnockPayload): string {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const ct = xchacha20poly1305(key, nonce).encrypt(enc.encode(JSON.stringify(payload)))
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return btoa(String.fromCharCode(...out))
}

/**
 * Try to open a knock. Returns null on any failure — wrong answer, malformed blob, someone else's
 * knock — and the caller must treat all of those identically. A failed knock is never surfaced,
 * which is the point: an attacker learns nothing, not even that they were close.
 */
export function openKnock(key: Uint8Array, sealed: string): KnockPayload | null {
  try {
    const raw = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0))
    if (raw.length < 25) return null
    const payload = xchacha20poly1305(key, raw.subarray(0, 24)).decrypt(raw.subarray(24))
    const parsed = JSON.parse(dec.decode(payload)) as KnockPayload
    if (parsed.v !== 1 || !parsed.pubkey) return null
    return parsed
  } catch {
    return null
  }
}
