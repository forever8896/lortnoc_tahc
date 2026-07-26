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
  // If this peer gates contact, we must knock before we can message (§6.8).
  const [knockPrompt, setKnockPrompt] = useState<string | null>(null)
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
    let live = true
    void backend.peerKnockPrompt(peer).then((p) => live && setKnockPrompt(p))
    return () => { live = false }
  }, [backend, peer])

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
  // Once you have history you are already through the door; the gate is for first contact only.
  const mustKnock = !!knockPrompt && (conv?.messages.length ?? 0) === 0

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

      {mustKnock ? (
        <KnockComposer peer={peer} prompt={knockPrompt!} onSent={() => setKnockPrompt(null)} />
      ) : (
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
      )}
      <style>{`@media (min-width:721px){ .hide-desktop{ display:none; } }`}</style>
    </div>
  )
}

/**
 * First contact with someone who gates it. You cannot message them until you answer their
 * question — and a wrong answer looks exactly like a right one from here, because they are the
 * only person who can tell the difference.
 */
function KnockComposer({ peer, prompt, onSent }: { peer: string; prompt: string; onSent: () => void }) {
  const { backend } = useBackend()
  const [answer, setAnswer] = useState('')
  const [intro, setIntro] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')

  async function knock(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const r = await backend.sendKnock(peer, answer, intro)
      if (r === 'no-knock') {
        onSent() // they stopped gating contact — fall through to the normal composer
        return
      }
      setDone(true)
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="mono" style={{ padding: 'var(--shell)', borderTop: '1px solid var(--rule)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
        <span className="signal">Knock sent.</span> If your answer was right it is waiting in their
        inbox, with your key attached — accepting it opens the conversation.
        <br />
        <span style={{ color: 'var(--faint)' }}>
          If it was wrong, nothing happened and they will never know you tried. We cannot tell you which.
        </span>
      </div>
    )
  }

  return (
    <form onSubmit={knock} style={{ padding: 'var(--shell)', borderTop: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
        {shortHandle(peer)} only accepts contact from people who can answer:
      </div>
      <div style={{ fontSize: 15 }}>“{prompt}”</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input mono"
          style={{ flex: '1 1 180px', fontSize: 12 }}
          placeholder="your answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <input
          className="input"
          style={{ flex: '2 1 240px', fontSize: 13 }}
          placeholder="say hello — who are you?"
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
        />
        <button className="btn btn--sm" disabled={busy || !answer.trim()}>
          {busy ? 'deriving…' : 'knock'}
        </button>
      </div>
      {err && <div className="mono" style={{ fontSize: 11, color: '#f0806a' }}>{err}</div>}
      <div className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>
        Your answer never leaves this device — it derives a key here (~1s) and that key seals the
        introduction.
      </div>
    </form>
  )
}
