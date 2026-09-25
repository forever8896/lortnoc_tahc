// Types for squeeze.mjs — the module stays plain JS so plain-node callers (tests, scripts) can
// import it without a build step, while the extension still gets checked.

/** Number of entries in the dictionary. Pinned by test/unit/squeeze.test.mjs. */
export const TABLE_SIZE: number

/** Order-sensitive checksum of the dictionary, so a reorder fails a test and not the field. */
export function tableChecksum(): number

/** Compress text to bytes. May be LARGER than the input — compare before shipping it. */
export function squeeze(text: string): Uint8Array

/** Reverse of squeeze. Returns null if the bytes are not a well-formed squeeze stream. */
export function unsqueeze(bytes: Uint8Array): string | null

/** Squeeze only when it wins; the flag records which form the bytes are in. */
export function squeezeIfSmaller(text: string): { bytes: Uint8Array; compressed: boolean }

/** Inverse of squeezeIfSmaller. Returns null on malformed input. */
export function unsqueezeMaybe(bytes: Uint8Array, compressed: boolean): string | null
