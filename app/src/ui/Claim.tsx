import { useEffect, useState } from 'react'
import { useBackend } from '../lib/ctx'
import { Eyebrow, Spinner, Wordmark } from './atoms'

export function Claim() {
  const { backend, identity, setIdentity } = useBackend()
  const [name, setName] = useState('')
  const [avail, setAvail] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')

  useEffect(() => {
    if (!clean) {
      setAvail(null)
      return
    }
    let live = true
    void backend.isHandleAvailable(clean).then((a) => live && setAvail(a))
    return () => {
      live = false
    }
  }, [clean, backend])

  async function claim() {
    setBusy(true)
    setErr('')
    try {
      setIdentity(await backend.claimHandle(clean))
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 'var(--shell)' }}>
      <div style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Wordmark small />
          <span className="chip mono">{identity?.address.slice(0, 10)}…</span>
        </div>
        <Eyebrow signal>Claim your handle</Eyebrow>
        <h1 style={{ margin: 0, fontWeight: 400, fontSize: 'clamp(30px,5vw,52px)', letterSpacing: '-0.03em', lineHeight: 1.05 }}>
          Pick a name.
          <br />
          It’s yours to hold.
        </h1>
        <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.65 }}>
          Your handle is an ENS subdomain — a real, portable identity. It carries your messaging key, so
          people can reach you and pay you, and it belongs to you, not to us.
        </p>

        <div>
          <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--rule)', background: 'var(--panel)' }}>
            <input
              className="input"
              style={{ border: 0, textAlign: 'right', fontFamily: 'var(--mono)' }}
              placeholder="yourname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <span className="mono" style={{ display: 'grid', placeItems: 'center', padding: '0 16px', color: 'var(--muted)', borderLeft: '1px solid var(--rule)' }}>
              .lortnoctahc.eth
            </span>
          </div>
          <div className="mono" style={{ fontSize: 12, marginTop: 8, minHeight: 16 }}>
            {!clean ? (
              <span style={{ color: 'var(--faint)' }}>lowercase letters, numbers, hyphens</span>
            ) : avail === null ? (
              <span style={{ color: 'var(--faint) ' }}>checking…</span>
            ) : avail ? (
              <span className="signal">✓ {clean}.lortnoctahc.eth is available</span>
            ) : (
              <span style={{ color: '#f0806a' }}>✕ taken</span>
            )}
          </div>
        </div>

        {err && <div className="mono" style={{ color: '#f0806a', fontSize: 13 }}>{err}</div>}

        <button className="btn" disabled={!clean || avail === false || busy} onClick={claim}>
          {busy ? (
            <>
              <Spinner /> claiming on-chain…
            </>
          ) : (
            <>Claim {clean || 'your'}.lortnoctahc.eth</>
          )}
        </button>
        <p className="mono" style={{ color: 'var(--faint)', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          {backend.health().mode === 'demo'
            ? 'Demo: published to a local directory + your pubkey attached. Live: a per-user ENS v2 Permissioned Resolver on Sepolia, pubkey written to eth.lortnoc.pubkey.'
            : 'Deploys your Permissioned Resolver proxy and writes eth.lortnoc.pubkey on ENS v2 (Sepolia).'}
        </p>
      </div>
    </main>
  )
}
