// Types for xframe.mjs — the module stays plain JS so plain-node callers (tests, scripts) can
// import it without a build step, while the extension still gets checked.

/** Parsed frame header + payload. */
export type XFrame = {
  mode: number
  /** Payload was squeezed (shared/squeeze.mjs). */
  squeezed: boolean
  /** Part of a multi-post thread; `tid` is present. */
  threaded: boolean
  /** 0-based thread position. */
  seq: number
  /** Thread length; 1 for a single post. */
  total: number
  /** Thread id (first two ciphertext bytes), or null for a single post. */
  tid: number | null
  /** A slice of the ciphertext, still encrypted. */
  payload: Uint8Array
}

/** Payload shape per mode (PRD-x-extension.md §6). Only PUBLIC is implemented today. */
export const X_MODE: Readonly<{
  PUBLIC: 0x2
  SHARED: 0x3
  RECIPIENTS: 0x4
}>

/** Max parts in one thread — the 4-bit `total` field. */
export const MAX_PARTS: number

/** The rendezvous marker. A deliberate marker — see PRD §3 on why the X threat model differs. */
export const HASHTAG: string

export type BuildOpts = {
  /** Set when the plaintext was squeezed before encryption. */
  squeezed?: boolean
  /** Payload bytes per post; defaults to "all of it" (a single post). */
  chunkBytes?: number
}

/** Split a ciphertext into frames, one per post. Throws on an unknown mode or >MAX_PARTS. */
export function buildXFrames(mode: number, ciphertext: Uint8Array, opts?: BuildOpts): Uint8Array[]

/** Convenience for the single-post case. */
export function buildXFrame(mode: number, ciphertext: Uint8Array, opts?: BuildOpts): Uint8Array

/** Parse a frame, or null when these bytes cannot be one. */
export function parseXFrame(bytes: Uint8Array): XFrame | null

/** Collects thread parts, out of order, until a thread is complete. Fails closed on gaps. */
export class ThreadCollector {
  constructor(maxThreads?: number)
  /** Returns the reassembled ciphertext, or null while parts are missing. */
  offer(frame: XFrame): Uint8Array | null
  clear(): void
}

/** Append the rendezvous tag to cover text. */
export function appendTag(coverText: string): string

/** Recover cover text from a posted tweet, or null when the tag is absent. */
export function stripTag(tweetText: string): string | null
