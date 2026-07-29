// Print the handle-owning EVM address (K_own) a given wallet key derives, so the CLI addresses
// the same owner the browser does.
//
// The derivation used to be hand-inlined here, "mirroring app/src/lib/crypto.ts" by convention
// alone. Had the two drifted, the CLI would mint a handle to an address nobody holds and nothing
// would report an error. Both now call shared/keys.mjs.
import { privateKeyToAccount } from 'viem/accounts'
import { deriveMasterSecret, deriveOwnerKey } from '../../shared/keys.mjs'

const seed = Buffer.from(process.env.PRIVATE_KEY.replace(/^0x/, ''), 'hex')
console.log(privateKeyToAccount(deriveOwnerKey(deriveMasterSecret(seed)).privHex).address)
