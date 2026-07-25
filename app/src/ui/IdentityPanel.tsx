import { useCallback, useEffect, useState } from 'react'
import { useBackend } from '../lib/ctx'
import type { EnsStatus } from '../lib/types'
import { Eyebrow, Spinner, shortHandle } from './atoms'

/** Your identity + the ENS v2 permission surface, read live off your own resolver. */
export function IdentityPanel({ onClose }: { onClose: () => void }) {
  const { backend, identity, setIdentity } = useBackend()
  const [status, setStatus] = useState<EnsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await backend.ensStatus())
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }, [backend])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function toggleDelegation(grant: boolean) {
    setBusy(true)
    setErr('')
    setNote('')
    try {
      setNote(await backend.delegateInbox(grant))
      await refresh()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const live = status?.live ?? false
  const delegated = status?.inboxDelegated ?? false

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 620, padding: 26, display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '90dvh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Eyebrow signal>Your identity</Eyebrow>
          <button className="chip" onClick={onClose} style={{ cursor: 'pointer' }}>close</button>
        </div>

        <div>
          <div style={{ fontSize: 28, fontFamily: 'Questrial', letterSpacing: '-0.01em' }}>
            {shortHandle(identity!.handle!)}
            <span style={{ color: 'var(--muted)' }}>.lortnoctahc.eth</span>
          </div>
          <Field label="eth.lortnoc.pubkey" value={identity!.pubkeyHex} />
          <Field label="identity wallet" value={identity!.address} />
        </div>

        <hr className="rule" />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <Eyebrow>ENS v2 — self-sovereignty</Eyebrow>
            <span className="chip mono" style={{ fontSize: 10 }}>
              {live ? 'Sepolia · on-chain' : 'demo mode'}
            </span>
          </div>

          {status?.resolver && (
            <div>
              <Field label="your Permissioned Resolver (a proxy only you admin)" value={status.resolver} />
              <div className="mono" style={{ fontSize: 11, marginTop: 6, color: status.factoryVerified ? 'var(--signal)' : '#f0806a' }}>
                {status.factoryVerified
                  ? '✓ verifyContract(proxy) → canonical PermissionedResolverImpl — nobody has to trust our backend'
                  : `✕ implementation mismatch: ${status.impl}`}
              </div>
            </div>
          )}

          {/* The load-bearing bit: who may write WHICH record, read live from the resolver. */}
          <PermTable status={status} />

          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            Per-record write delegation: let a sync gateway rotate <span className="signal">only</span> your
            inbox pointer — never your pubkey — and take it back in one transaction.
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn--ghost btn--sm" disabled={busy || !identity?.handle || delegated} onClick={() => toggleDelegation(true)}>
              {busy && !delegated ? <Spinner /> : null} Delegate inbox → gateway
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy || !delegated} onClick={() => toggleDelegation(false)}>
              {busy && delegated ? <Spinner /> : null} Revoke
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void refresh()}>
              re-read chain
            </button>
          </div>

          {note && <Note>{note}</Note>}
          {err && <Note bad>{err}</Note>}

          {status?.explorer && (
            <a
              className="mono"
              href={status.explorer}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11, color: 'var(--muted)' }}
            >
              view resolver on Etherscan ↗
            </a>
          )}
        </div>

        <hr className="rule" />
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => {
            sessionStorage.clear()
            setIdentity(null)
          }}
        >
          Sign out (clear this device)
        </button>
      </div>
    </div>
  )
}

/** Who can write what, right now. In live mode every cell is an `eth_call` against the real
 *  authorization path — not a claim about what should happen. */
function PermTable({ status }: { status: EnsStatus | null }) {
  if (!status) return <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>reading chain…</div>

  const cell = (allowed: boolean) => (
    <span style={{ color: allowed ? 'var(--signal)' : 'var(--faint)' }}>{allowed ? 'write' : '—'}</span>
  )

  return (
    <div style={{ border: '1px solid var(--rule)', overflowX: 'auto' }}>
      <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ color: 'var(--faint)', textAlign: 'left' }}>
            <th style={th}>record</th>
            <th style={th}>value</th>
            <th style={{ ...th, textAlign: 'center' }}>you</th>
            <th style={{ ...th, textAlign: 'center' }}>gateway</th>
          </tr>
        </thead>
        <tbody>
          {status.perms.map((p) => (
            <tr key={p.key} style={{ borderTop: '1px solid var(--rule)' }}>
              <td style={td}>{p.key.replace('eth.lortnoc.', '')}</td>
              <td style={{ ...td, color: 'var(--muted)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.value ?? '—'}
              </td>
              <td style={{ ...td, textAlign: 'center' }}>{cell(p.ownerCanWrite)}</td>
              <td style={{ ...td, textAlign: 'center' }}>{cell(p.gatewayCanWrite)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mono" style={{ fontSize: 10, color: 'var(--faint)', padding: '6px 10px', borderTop: '1px solid var(--rule)' }}>
        {status.live
          ? 'each cell simulated against the live resolver · roles gate writes only — records stay world-readable'
          : 'demo mode — the live app measures these on-chain'}
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '7px 10px', fontWeight: 400 }
const td: React.CSSProperties = { padding: '7px 10px' }

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="eyebrow" style={{ fontSize: 10 }}>{label}</div>
      <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all', marginTop: 3 }}>
        {value}
      </div>
    </div>
  )
}

function Note({ children, bad }: { children: React.ReactNode; bad?: boolean }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 11,
        lineHeight: 1.6,
        padding: '10px 12px',
        border: `1px solid ${bad ? 'rgba(240,128,106,0.35)' : 'var(--rule)'}`,
        color: bad ? '#f0806a' : 'var(--muted)',
        wordBreak: 'break-word',
      }}
    >
      {children}
    </div>
  )
}
