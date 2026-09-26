// Icons for the chips, pill and toast the content script puts into the host page. Separate from
// shared/icons.ts on purpose: this file is injected as a CLASSIC script, so it must share no chunk
// with the extension pages (see scan.ts). The `&content` query makes these imports distinct modules
// that the bundler cannot hoist into a shared chunk. Same Phosphor family as everywhere else.
import lock from '@phosphor-icons/core/assets/regular/lock-simple.svg?raw&content'
import unlock from '@phosphor-icons/core/assets/regular/lock-simple-open.svg?raw&content'
import magnifier from '@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw&content'

const RAW = { lock, unlock, magnifier }

/** The icon as a DOM node, built without innerHTML: safe in pages that enforce Trusted Types. */
export function iconNode(name: keyof typeof RAW, size = '1em'): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 256 256')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.flex = 'none'
  for (const m of RAW[name].matchAll(/<path d="([^"]+)"/g)) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', m[1])
    svg.append(p)
  }
  return svg
}
