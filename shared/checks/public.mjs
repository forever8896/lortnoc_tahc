// `public` — anyone with the extension can open it.
//
// OBFUSCATION, NOT A LOCK. The mask comes from K_public, derived from a constant every install
// shares (shared/keys.mjs derivePublicChannelKey), so it hides the post from people without the
// tool and from nobody else. flags.anyoneCanOpen makes the builder say so and never draw a lock.
import { derivePublicChannelKey } from '../keys.mjs'

const LABEL = 'lortnoc/policy/public/v1'
let kPublic
const key = () => (kPublic ??= derivePublicChannelKey())

export default {
  id: 'public',
  tag: 1,
  kind: 'inline',
  flags: { anyoneCanOpen: true },
  describe: () => 'Anyone with the extension',
  encodeParams: () => [],
  decodeParams: (_bytes, at) => ({ params: {}, at }),
  async seal(ctx, share) {
    return ctx.xor(share, ctx.mask(key(), LABEL))
  },
  readMaterial: (bytes, at) => ({ material: bytes.subarray(at, at + 16), at: at + 16 }),
  async open(ctx, wrap) {
    if (ctx.inputs.usePublic === false) return []
    return [ctx.xor(wrap, ctx.mask(key(), LABEL))]
  },
}
