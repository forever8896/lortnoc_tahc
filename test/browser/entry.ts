// Bundle entry for the browser tier: exposes the REAL content-script modules on `window` so
// Playwright can drive them against the fixture DOM.
//
// This is the only place the browser tests touch. Everything under test is imported from
// extension/src — no re-implementation, same rule as the rest of the suite.
import * as selectors from '../../extension/src/content/selectors'
import * as compose from '../../extension/src/content/compose'
import * as inbound from '../../extension/src/content/inbound'
import * as crypto from '../../extension/src/content/crypto'
import * as handshake from '../../extension/src/content/handshake'

declare global {
  interface Window {
    lortnoc: {
      selectors: typeof selectors
      compose: typeof compose
      inbound: typeof inbound
      crypto: typeof crypto
      handshake: typeof handshake
      RETRY: typeof inbound.RETRY
    }
  }
}

window.lortnoc = { selectors, compose, inbound, crypto, handshake, RETRY: inbound.RETRY }
