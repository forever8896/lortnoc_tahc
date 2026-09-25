// Bundle entry for the X browser tier: exposes the REAL extension-x content modules on `window`
// so Playwright can drive them against the fixture DOM.
//
// Everything under test is imported from extension-x/src — no re-implementation, same rule as
// the rest of the suite.
import * as selectors from '../../extension-x/src/content/selectors'
import * as compose from '../../extension-x/src/content/compose'
import * as inbound from '../../extension-x/src/content/inbound'
import * as crypto from '../../extension-x/src/content/crypto'

declare global {
  interface Window {
    lortnocX: {
      selectors: typeof selectors
      compose: typeof compose
      inbound: typeof inbound
      crypto: typeof crypto
      RETRY: typeof inbound.RETRY
    }
  }
}

window.lortnocX = { selectors, compose, inbound, crypto, RETRY: inbound.RETRY }
