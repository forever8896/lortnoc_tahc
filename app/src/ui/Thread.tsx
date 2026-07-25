import { useCallback, useEffect, useRef, useState } from 'react'
import { useBackend } from '../lib/ctx'
import type { Conversation } from '../lib/types'
import { fullHandle } from '../lib/backend'
import { Avatar, shortHandle } from './atoms'

export function Thread({ peer, onBack, onSent }: { peer: string; onBack: () => void; onSent: () => void }) {
  const { backend, identity } = useBackend()
  const [conv, setConv] = useState<Conversation | null>(null)
  const [body, setBody] = useState('')
  const [err, setErr] = useState('')
  const [reveal, setReveal] = useState<number | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      setConv(await backend.getConversation(peer))
      setErr('')
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }, [backend, peer])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 2500)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conv?.messages.length])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const text = body.trim()
    if (!text) return
    setBody('')
    setErr('')
    try {
      await backend.send(peer, text)
      await load()
      onSent()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }

  const peerH = peer.includes('.') ? peer : fullHandle(peer)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', minWidth: 0 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '13px var(--shell)',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <button className="btn--ghost btn btn--sm hide-desktop" onClick={onBack} style={{ padding: '6px 10px' }}>
          ‹
        </button>
        <Avatar handle={peerH} size={34} />
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 14 }}>{shortHandle(peerH)}</div>
          <div className="mono signal" style={{ fontSize: 11 }}>end-to-end encrypted</div>
        </div>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--shell)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {conv?.messages.length === 0 && (
          <div className="mono" style={{ color: 'var(--faint)', fontSize: 12, margin: 'auto', textAlign: 'center', maxWidth: 340, lineHeight: 1.6 }}>
            Nothing here yet. Your first message derives a shared key with{' '}
            <span className="signal">{shortHandle(peerH)}</span> via ECDH — no secret is ever sent.
          </div>
        )}
        {conv?.messages.map((m, i) => {
          const mine = m.from === identity!.handle
          return (
            <div key={i} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              <button
                onClick={() => setReveal(reveal === i ? null : i)}
                style={{
                  maxWidth: 'min(78%, 560px)',
                  textAlign: 'left',
                  padding: '10px 14px',
                  background: mine ? 'rgba(18, 196, 190,0.12)' : 'var(--panel)',
                  border: `1px solid ${mine ? 'rgba(18, 196, 190,0.3)' : 'var(--rule)'}`,
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: 15,
                  lineHeight: 1.5,
                }}
                title="what's actually stored"
              >
                {m.body}
                {reveal === i && (
                  <div className="mono" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                    stored Seal-encrypted on Walrus · only your key decrypts it ·{' '}
                    {new Date(m.ts).toLocaleTimeString()}
                  </div>
                )}
              </button>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      {err && (
        <div className="mono" style={{ color: '#f0806a', fontSize: 12, padding: '8px var(--shell)' }}>
          {err}
        </div>
      )}

      <form onSubmit={send} style={{ display: 'flex', gap: 10, padding: 'var(--shell)', borderTop: '1px solid var(--rule)' }}>
        <input
          className="input"
          placeholder={`message ${shortHandle(peerH)}…`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button className="btn" disabled={!body.trim()}>
          Send
        </button>
      </form>
      <style>{`@media (min-width:721px){ .hide-desktop{ display:none; } }`}</style>
    </div>
  )
}
