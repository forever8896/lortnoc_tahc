import { useCallback, useEffect, useState } from 'react'
import { useBackend } from '../lib/ctx'
import type { Conversation } from '../lib/types'
import { Avatar, Wordmark, shortHandle } from './atoms'
import { Thread } from './Thread'
import { IdentityPanel } from './IdentityPanel'

export function Messenger() {
  const { backend, identity } = useBackend()
  const [convos, setConvos] = useState<Conversation[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [newTo, setNewTo] = useState('')
  const [showMe, setShowMe] = useState(false)
  const [mobileThread, setMobileThread] = useState(false)

  const refresh = useCallback(async () => {
    setConvos(await backend.listConversations())
  }, [backend])

  // poll (Walrus is a durable log, not a bus — §6.4)
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 2500)
    return () => clearInterval(t)
  }, [refresh])

  function openPeer(peer: string) {
    setActive(peer)
    setMobileThread(true)
  }
  async function startNew(e: React.FormEvent) {
    e.preventDefault()
    const h = newTo.trim().toLowerCase()
    if (!h) return
    setNewTo('')
    openPeer(h.replace('.lortnoc.eth', ''))
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
        <footer className="mgr__foot mono">🔒 encrypted to your key · stored on your vault</footer>
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
