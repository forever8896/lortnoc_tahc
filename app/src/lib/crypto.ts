// Client-side crypto — shared with the extension (§5.1/§5.3). Keys never leave the device.
//
// The implementation lives in shared/keys.mjs: one copy of the §5.1 derivation table for the
// app, the extension, the CLI and the relayer. It was previously inlined here, in
// extension/src/content/crypto.ts, in scripts/ens/derive.mjs, and again (for id_sem and
// K_sui) inside live/proof.ts, live/membership.ts and live.ts — seven hand-written copies of
// key material that MUST agree, with nothing checking that they did.
export {
  deriveMasterSecret,
  deriveMessagingKey,
  deriveOwnerKey,
  deriveSuiKey,
  deriveSealKey,
  deriveSemaphoreSecret,
  deriveConvKey,
  genKeyPair,
  encrypt,
  tryDecrypt,
  toHex,
  fromHex,
  toB64,
  fromB64,
  LABEL,
} from '../../../shared/keys.mjs'

export type { KeyPair } from '../../../shared/keys.mjs'
