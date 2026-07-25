// Types for ticket.mjs — the module stays plain JS so plain-node callers (scripts/, relayer/)
// can import it without a build step, while the app still gets checked.

/**
 * The public signal a membership ticket commits to.
 * Binds everything a claim decides, so whoever submits the proof cannot point it elsewhere.
 */
export function ticketMessage(
  label: string,
  evmAddr: string,
  suiAddr: string,
  pubkeyHex: string,
): bigint

/** Fixed claim scope ⇒ one nullifier per identity ⇒ one handle per membership. */
export function claimScope(): bigint

export const CLAIM_SCOPE_SEED: string
