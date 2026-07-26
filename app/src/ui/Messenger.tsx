import { useCallback, useEffect, useState } from 'react'
import { useBackend } from '../lib/ctx'
import type { Conversation, OpenedKnock } from '../lib/types'
import { Avatar, Wordmark, shortHandle } from './atoms'
import { shortName } from '../lib/backend'
import { Thread } from './Thread'
import { IdentityPanel } from './IdentityPanel'

export function Messenger() {
  const { backend, identity } = useBackend()
  const [convos, setConvos] = useState<Conversation[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [newTo, setNewTo] = useState('')
  const [showMe, setShowMe] = useState(false)
  const [mobileThread, setMobileThread] = useState(false)

  const [knocks, setKnocks] = useState<OpenedKnock[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])

  const [knockState, setKnockState] = useState<'none' | 'armed' | 'locked'>('none')

  const refresh = useCallback(async () => {
    setConvos(await backend.listConversations())
    // Knocks arrive at a relay, not in the conversation store, so nothing else would ever
    // surface them. Silent on failure: a knock check must not break the inbox.
    try {
      const state = await backend.knockState()
      setKnockState(state)
      setKnocks(state === 'armed' ? await backend.pendingKnocks() : [])
    } catch {
      /* ignore */
    }
  }, [backend])

  // Poll (Walrus is a durable log, not a bus — §6.4). The OPEN thread refreshes on its own at a
  // faster cadence; this pass walks every conversation plus the knock relay, so running it as
  // often just queued work faster than it completed.
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [refresh])

  // One row per person, newest kept. Retrying a knock is normal (a wrong answer is silent, so
  // people try again), and pendingKnocks returns them sorted newest-first — showing each attempt
  // separately turns one contact into a wall of identical rows. Anonymous knocks fall back to the
  // pubkey, which is the only stable identity they have.
  const seenFrom = new Set<string>()
  const newKnocks = knocks
    .filter((k) => !dismissed.includes(k.id))
    .filter((k) => {
      const who = k.from ?? k.pubkey
      if (seenFrom.has(who)) return false
      seenFrom.add(who)
      return true
    })

  function openPeer(peer: string) {
    setActive(peer)
    setMobileThread(true)
  }
  async function startNew(e: React.FormEvent) {
    e.preventDefault()
    const h = newTo.trim().toLowerCase()
    if (!h) return
    setNewTo('')
    openPeer(shortName(h))
    void refresh()
  }

  return (
    <div className="mgr">
      <aside className="mgr__side" data-hidden={mobileThread}>
        <header className="mgr__brand">
          <Wordmark small />
          <button className="chip" onClick={() => setShowMe(true)} title="your identity">
            {shortHandle(identity!.handle!)}
          </button>
        </header>
        <form className="mgr__new" onSubmit={startNew}>
          <input
            className="input"
            style={{ fontFamily: 'var(--mono)', fontSize: 14 }}
            placeholder="message a handle…"
            value={newTo}
            onChange={(e) => setNewTo(e.target.value)}
          />
        </form>
        {knockState === 'locked' && <UnlockKnocks onUnlocked={refresh} />}
        {newKnocks.length > 0 && (
          <div className="mgr__knocks">
            <div className="mono mgr__knocks__hd">
              {newKnocks.length} {newKnocks.length === 1 ? 'person' : 'people'} answered your question
            </div>
            {newKnocks.map((k) => (
              <div key={k.id} className="mgr__knock">
                <div className="mono" style={{ fontSize: 12 }}>
                  <span className="signal">{k.from ? shortHandle(k.from) : 'someone'}</span> wants to
                  connect
                </div>
                {k.intro && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>“{k.intro}”</div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                  {k.from ? (
                    <button
                      className="btn btn--sm"
                      type="button"
                      onClick={async () => {
                        setDismissed((d) => [...d, k.id])
                        // Record the acceptance BEFORE opening, so the thread has a conversation
                        // to belong to and the peer's own gate no longer applies to our reply.
                        try {
                          await backend.acceptKnock(k.from!)
                        } catch (e) {
                          console.warn('[lortnoc] could not record the accepted knock:', e)
                        }
                        openPeer(shortName(k.from!))
                        void refresh()
                      }}
                    >
                      open conversation
                    </button>
                  ) : (
                    // Their key came through, but without a handle there is no ENS record to
                    // resolve and so nothing to address a thread to.
                    <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>
                      no handle attached — cannot open a thread
                    </span>
                  )}
                  <button className="btn btn--ghost btn--sm" onClick={() => setDismissed((d) => [...d, k.id])}>
                    ignore
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mgr__list">
          {convos.length === 0 && (
            <div className="mono" style={{ color: 'var(--faint)', fontSize: 12, padding: 16, lineHeight: 1.6 }}>
              No conversations yet. Type a <span className="signal">handle</span> above to start one. (Open a
              second browser tab, claim a different handle, and message this one to see it work end-to-end.)
            </div>
          )}
          {convos.map((c) => {
            const last = c.messages.at(-1)
            return (
              <button
                key={c.convId}
                className="mgr__row"
                data-active={active === shortHandle(c.peer)}
                onClick={() => openPeer(shortHandle(c.peer))}
              >
                <Avatar handle={c.peer} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="mono" style={{ fontSize: 13 }}>{shortHandle(c.peer)}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {last ? (last.from === identity!.handle ? 'You: ' : '') + last.body : 'no messages'}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        <footer className="mgr__foot mono">encrypted to your key · stored on your vault</footer>
      </aside>

      <main className="mgr__main" data-shown={mobileThread}>
        {active ? (
          <Thread peer={active} onBack={() => setMobileThread(false)} onSent={refresh} />
        ) : (
          <div className="mgr__empty mono">
            <Avatar handle="lortnoc" size={54} />
            <p>Select a conversation, or message a handle to begin.</p>
          </div>
        )}
      </main>

      {showMe && <IdentityPanel onClose={() => setShowMe(false)} />}
      <MessengerStyles />
    </div>
  )
}

/**
 * A published question can only be answered by someone who knows the answer — including you.
 * Opening knocks needs the key that answer derives, and we deliberately never store the answer,
 * so a fresh tab cannot read anything until you supply it once.
 *
 * This row is what stands between "gated contact" and "silence". Note what it does NOT say: how
 * many sealed knocks are waiting. That number would reveal that wrong answers had arrived, and
 * §6.8 promises you are never told that.
 */
function UnlockKnocks({ onUnlocked }: { onUnlocked: () => void }) {
  const { backend } = useBackend()
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function unlock(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await backend.readKnocks(answer) // caches the derived key; polling takes over from here
      setAnswer('')
      onUnlocked()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mgr__knocks" onSubmit={unlock} style={{ padding: '10px var(--shell) 12px' }}>
      <div className="mono mgr__knocks__hd" style={{ padding: '0 0 6px' }}>
        knocks are locked
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 7 }}>
        Your answer never gets stored, so this tab cannot open knocks until you give it once.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input mono"
          style={{ flex: 1, fontSize: 12 }}
          placeholder="your answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <button className="btn btn--sm" disabled={busy || !answer.trim()}>
          {busy ? 'deriving…' : 'unlock'}
        </button>
      </div>
      {err && <div className="mono" style={{ fontSize: 11, color: '#f0806a', marginTop: 6 }}>{err}</div>}
    </form>
  )
}

function MessengerStyles() {
  return (
    <style>{`
    .mgr { height:100dvh; display:grid; grid-template-columns:minmax(280px,340px) 1fr; }
    .mgr__side { border-right:1px solid var(--rule); display:flex; flex-direction:column; min-height:0; background:var(--bg); }
    .mgr__brand { display:flex; align-items:center; justify-content:space-between; padding:16px var(--shell); border-bottom:1px solid var(--rule); }
    .mgr__brand .chip { cursor:pointer; }
    .mgr__new { padding:12px var(--shell); border-bottom:1px solid var(--rule); }
    .mgr__list { flex:1; overflow-y:auto; min-height:0; }
    .mgr__row { width:100%; display:flex; gap:12px; align-items:center; padding:13px var(--shell); background:none; border:0; border-bottom:1px solid var(--rule); color:var(--ink); cursor:pointer; text-align:left; }
    .mgr__row:hover { background:var(--panel); }
    .mgr__row[data-active="true"] { background:var(--panel); box-shadow:inset 2px 0 0 var(--signal); }
    .mgr__knocks { border-bottom:1px solid var(--rule); background:rgba(18,196,190,0.05); }
    .mgr__knocks__hd { font-size:10px; color:var(--signal); padding:9px var(--shell) 3px; letter-spacing:0.08em; text-transform:uppercase; }
    .mgr__knock { padding:8px var(--shell) 12px; }
    .mgr__foot { padding:12px var(--shell); border-top:1px solid var(--rule); color:var(--faint); font-size:11px; }
    .mgr__main { min-width:0; display:flex; flex-direction:column; }
    .mgr__empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; color:var(--faint); }
    @media (max-width:720px) {
      .mgr { grid-template-columns:1fr; }
      .mgr__side[data-hidden="true"] { display:none; }
      .mgr__main { display:none; }
      .mgr__main[data-shown="true"] { display:flex; }
    }
  `}</style>
  )
}
