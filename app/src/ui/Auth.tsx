import { useState } from 'react'
import { useBackend } from '../lib/ctx'
import { Eyebrow, Spinner, Wordmark } from './atoms'

export function Auth() {
  const { backend, setIdentity } = useBackend()
  const [busy, setBusy] = useState(false)
  const mode = backend.health().mode

  async function connect() {
    setBusy(true)
    try {
      setIdentity(await backend.connect())
    } finally {
      setBusy(false)
    }
  }

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        padding: 'var(--shell)',
        maxWidth: 1100,
        margin: '0 auto',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Wordmark />
        <span className="chip">{mode === 'demo' ? 'demo mode' : 'sepolia · sui testnet'}</span>
      </header>

      <section style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 28, maxWidth: 640 }}>
        <Eyebrow signal>The messenger you switch to</Eyebrow>
        <h1
          style={{
            margin: 0,
            fontWeight: 400,
            fontSize: 'clamp(40px,7vw,86px)',
            lineHeight: 0.98,
            letterSpacing: '-0.035em',
          }}
        >
          Your identity.
          <br />
          Your inbox.
          <br />
          <span className="signal">Yours.</span>
        </h1>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 18, lineHeight: 1.7, maxWidth: 520 }}>
          Every account is an ENS handle you claim and hold — your name, your inbox, and how you get paid.
          Messages are encrypted to your key and stored on a vault you own. Nothing to scan. Nobody to ask.
        </p>
        <div>
          <button className="btn" onClick={connect} disabled={busy}>
            {busy ? (
              <>
                <Spinner /> connecting…
              </>
            ) : (
              'Connect wallet'
            )}
          </button>
        </div>
        <p className="mono" style={{ color: 'var(--faint)', fontSize: 12, margin: 0, maxWidth: 520 }}>
          {mode === 'demo'
            ? 'Demo: a fresh keypair is generated locally (no wallet needed). Open a second tab to be a second person and chat for real — end-to-end encrypted.'
            : 'Connect & sign one message → your master secret is derived on-device (RFC 6979). The signature never leaves your device.'}
        </p>
      </section>

      <footer className="mono" style={{ color: 'var(--faint)', fontSize: 12, paddingTop: 24 }}>
        no server account · keys derived on-device · you can walk away and keep everything
      </footer>
    </main>
  )
}
