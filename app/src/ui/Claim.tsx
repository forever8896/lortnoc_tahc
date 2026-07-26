import { useEffect, useState } from 'react'
import { useBackend } from '../lib/ctx'
import type { ClaimStage } from '../lib/types'
import { Eyebrow, Spinner, Wordmark } from './atoms'

/** What each stage says while it runs. Proving takes real seconds; silence reads as a hang. */
const STAGE_COPY: Record<ClaimStage, string> = {
  'checking-membership': 'checking your membership…',
  'loading-group': 'loading the members set…',
  proving: 'proving you are a member — in this browser, ~15s. Your secret never leaves the device.',
  relaying: 'handing the proof to a relayer — it pays the gas, so your wallet stays unlinked',
  'waiting-for-ens': 'waiting for ENS to confirm…',
  'verifying-pubkey': 'verifying the published key is yours…',
  done: 'done',
}

export function Claim() {
  const { backend, identity, setIdentity } = useBackend()
  const [name, setName] = useState('')
  const [avail, setAvail] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [stage, setStage] = useState<ClaimStage | null>(null)
  const [paid, setPaid] = useState<boolean | null>(null)

  // Which path can we actually use? The paid one needs the relayer to be answering.
  useEffect(() => {
    let live = true
    void backend.paidClaimAvailable().then((v) => live && setPaid(v))
    return () => { live = false }
  }, [backend])

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
    setStage(null)
    try {
      // Paid path when the relayer is up: the handle is issued BY the relayer, so the wallet
      // that owns it never signs on Sepolia and stays unlinked from the payment.
      const id = paid
        ? await backend.claimHandlePaid(clean, setStage)
        : await backend.claimHandle(clean)
      setIdentity(id)
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
      setStage(null)
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
              <Spinner /> {stage ? STAGE_COPY[stage] : 'claiming on-chain…'}
            </>
          ) : (
            <>Claim {clean || 'your'}.lortnoctahc.eth</>
          )}
        </button>

        {busy && paid && <StageList stage={stage} />}
        <p className="mono" style={{ color: 'var(--faint)', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          {paid
            ? 'Issued by a relayer against your membership proof — the wallet that receives it never signs on Sepolia, so nothing on-chain connects it to your payment.'
            : backend.health().mode === 'demo'
            ? 'Demo: published to a local directory + your pubkey attached. Live: a per-user ENS v2 Permissioned Resolver on Sepolia, pubkey written to eth.lortnoc.pubkey.'
            : 'Deploys your Permissioned Resolver proxy and writes eth.lortnoc.pubkey on ENS v2 (Sepolia).'}
        </p>
      </div>
    </main>
  )
}

/** The five steps of a paid claim, so a 20-second proof doesn't look like a frozen tab. */
function StageList({ stage }: { stage: ClaimStage | null }) {
  const order: ClaimStage[] = [
    'checking-membership', 'loading-group', 'proving', 'relaying', 'waiting-for-ens', 'verifying-pubkey',
  ]
  const at = stage ? order.indexOf(stage) : -1
  return (
    <div className="mono" style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {order.map((s, i) => (
        <div key={s} style={{ color: i < at ? 'var(--signal)' : i === at ? 'var(--fg)' : 'var(--faint)' }}>
          {i < at ? '✓' : i === at ? '◐' : '·'} {STAGE_COPY[s]}
        </div>
      ))}
    </div>
  )
}
