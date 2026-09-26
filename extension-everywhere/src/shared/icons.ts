// One icon family for every surface: Phosphor (regular), bundled as strings, so nothing loads from a
// CDN and the content script can use them inside any page. Markup asks for one with
// <i data-icon="lock"></i>; code uses icon('lock').
import lock from '@phosphor-icons/core/assets/regular/lock-simple.svg?raw'
import unlock from '@phosphor-icons/core/assets/regular/lock-simple-open.svg?raw'
import check from '@phosphor-icons/core/assets/regular/check.svg?raw'
import x from '@phosphor-icons/core/assets/regular/x.svg?raw'
import refresh from '@phosphor-icons/core/assets/regular/arrows-clockwise.svg?raw'
import copy from '@phosphor-icons/core/assets/regular/copy.svg?raw'
import gear from '@phosphor-icons/core/assets/regular/gear-six.svg?raw'
import key from '@phosphor-icons/core/assets/regular/key.svg?raw'
import wallet from '@phosphor-icons/core/assets/regular/wallet.svg?raw'
import passport from '@phosphor-icons/core/assets/regular/identification-card.svg?raw'
import globe from '@phosphor-icons/core/assets/regular/globe-hemisphere-west.svg?raw'
import seal from '@phosphor-icons/core/assets/regular/seal-check.svg?raw'
import ban from '@phosphor-icons/core/assets/regular/prohibit.svg?raw'
import arrow from '@phosphor-icons/core/assets/regular/arrow-right.svg?raw'
import warning from '@phosphor-icons/core/assets/regular/warning.svg?raw'
import cube from '@phosphor-icons/core/assets/regular/cube.svg?raw'
import fingerprint from '@phosphor-icons/core/assets/regular/fingerprint.svg?raw'
import eye from '@phosphor-icons/core/assets/regular/eye.svg?raw'
import sparkle from '@phosphor-icons/core/assets/regular/sparkle.svg?raw'
import pencil from '@phosphor-icons/core/assets/regular/pencil-simple.svg?raw'
import magnifier from '@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw'
import plug from '@phosphor-icons/core/assets/regular/plugs-connected.svg?raw'
import signout from '@phosphor-icons/core/assets/regular/sign-out.svg?raw'
import user from '@phosphor-icons/core/assets/regular/user-circle-check.svg?raw'

const RAW = { lock, unlock, check, x, refresh, copy, gear, key, wallet, passport, globe, seal, ban, arrow, warning, cube, fingerprint, eye, sparkle, pencil, magnifier, plug, signout, user }
export type IconName = keyof typeof RAW

/** An inline SVG that sizes with the text (1em) and takes the text colour. */
export function icon(name: IconName, cls = ''): string {
  return RAW[name].replace('<svg ', `<svg class="i${cls ? ` ${cls}` : ''}" width="1em" height="1em" aria-hidden="true" focusable="false" `)
}

/** Fill every <i data-icon="…"> under `root`. */
export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((el) => {
    const n = el.dataset.icon as IconName
    if (RAW[n]) el.outerHTML = icon(n, el.className)
  })
}

