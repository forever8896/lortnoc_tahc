import { useState } from 'react'
import { useBackend } from '../lib/ctx'
import { Eyebrow, shortHandle } from './atoms'

export function IdentityPanel({ onClose }: { onClose: () => void }) {
  const { backend, identity, setIdentity } = useBackend()
  const [delegateMsg, setDelegateMsg] = useState('')
  const [verify, setVerify] = useState<{ ok: boolean; detail: string } | null>(null)

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 560, padding: 26, display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '90dvh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Eyebrow signal>Your identity</Eyebrow>
          <button className="chip" onClick={onClose} style={{ cursor: 'pointer' }}>close</button>
        </div>

        <div>
          <div style={{ fontSize: 28, fontFamily: 'Questrial', letterSpacing: '-0.01em' }}>
            {shortHandle(identity!.handle!)}
            <span style={{ color: 'var(--muted)' }}>.lortnoc.eth</span>
          </div>
          <Field label="eth.lortnoc.pubkey" value={identity!.pubkeyHex} />
          <Field label="identity wallet" value={identity!.address} />
        </div>

        <hr className="rule" />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Eyebrow>ENS v2 — self-sovereignty</Eyebrow>

          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            Per-record write delegation: let a sync gateway rotate <span className="signal">only</span> your
            inbox pointer — never your pubkey — revocable in one tx.
          </div>
          <button className="btn btn--ghost btn--sm" onClick={async () => setDelegateMsg(await backend.delegateInbox())}>
            Delegate inbox → gateway
          </button>
          {delegateMsg && <Note>{delegateMsg}</Note>}

          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginTop: 6 }}>
            Trustless handle proof: verify your resolver was deployed by the canonical factory.
          </div>
          <button className="btn btn--ghost btn--sm" onClick={async () => setVerify(await backend.verifyResolver())}>
            verifyContract(resolver)
          </button>
          {verify && <Note ok={verify.ok}>{verify.detail}</Note>}
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
function Note({ children, ok }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 11,
        lineHeight: 1.6,
        padding: '10px 12px',
        border: `1px solid ${ok ? 'rgba(74,222,128,0.35)' : 'var(--rule)'}`,
        color: ok ? 'var(--signal)' : 'var(--muted)',
      }}
    >
      {children}
    </div>
  )
}
