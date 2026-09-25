import { useCallback, useEffect, useRef, useState } from 'react'
import { useBackend } from '../lib/ctx'
import type { Conversation, OpenedKnock } from '../lib/types'
import { Avatar, Wordmark, shortHandle } from './atoms'
import { relativeTime } from './time'
import { fullHandle, shortName } from '../lib/backend'
import { Thread } from './Thread'
import { IdentityPanel } from './IdentityPanel'
import { notify, notifyPermission, requestNotify, setBadge, type NotifyPermission } from '../lib/notify'
import {
  loadAnnouncedKnocks, loadWatermarks, newestInbound, saveAnnouncedKnocks, saveWatermarks,
  seedWatermarks, unreadByPeer, type Watermarks,
} from '../lib/unread'

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

  const [unread, setUnread] = useState<Record<string, number>>({})
  const [perm, setPerm] = useState<NotifyPermission>(notifyPermission())
  /** Why the inbox is empty, when the reason is not "you have no conversations". */
  const [inboxErr, setInboxErr] = useState('')
  /** Why the handle you just typed cannot be messaged, and whether we are still checking. */
  const [newErr, setNewErr] = useState('')
  const [checking, setChecking] = useState(false)

  // Which thread is on screen, read inside the poll. State would be captured stale by the
  // interval's closure and we would keep notifying for the conversation you are reading.
  const activeRef = useRef<string | null>(null)
  activeRef.current = active

  const refresh = useCallback(async () => {
    const me = identity?.handle ?? ''

    // listConversations() is guarded internally (per-peer allSettled), but it walks Sui and
    // Walrus and CAN still throw at the top. It used to sit outside this try, so one bad RPC
    // response meant the knock check below never ran — for that poll and every poll after it.
    let list: Conversation[] = []
    try {
      list = await backend.listConversations()
      setConvos(list)
      // Discovery is best-effort inside the backend, so a failure there does NOT throw here —
      // it comes back as a reason instead. Without this, a device that cannot reach Sui shows
      // the same cheerful "No conversations yet" as a brand-new account.
      setInboxErr(backend.discoveryError?.() ?? '')
    } catch (e) {
      console.warn('[lortnoc] conversation refresh failed (knocks still checked):', e)
      setInboxErr(String((e as Error)?.message ?? e))
    }

    // ---- new inbound messages -----------------------------------------------------------
    // A device with no stored watermark is signing in for the first time: seed it, or every
    // message in your history arrives as a banner at once. Seeding deliberately leaves the last
    // few minutes UNREAD (see FRESH_MS), so we still diff on the first pass — otherwise someone
    // messaging you seconds before you opened the app on this device would be silently marked
    // read, which is the exact demo you are most likely to run.
    const stored = loadWatermarks()
    const marks: Watermarks = stored ?? seedWatermarks(list, me)
    if (!stored) saveWatermarks(marks)

    const fresh = unreadByPeer(list, me, marks)
    const visible = document.visibilityState === 'visible'
    const counts: Record<string, number> = {}
    let changed = false

    for (const [peer, msgs] of Object.entries(fresh)) {
      // Reading a thread IS acknowledging it: if it is open on a visible screen, advance the
      // watermark instead of shouting about messages the user is looking at.
      if (visible && activeRef.current === shortHandle(peer)) {
        marks[peer] = msgs[msgs.length - 1].ts
        changed = true
        continue
      }
      counts[peer] = msgs.length
      const last = msgs[msgs.length - 1]
      void notify(
        `${shortHandle(peer)}`,
        msgs.length === 1 ? last.body : `${msgs.length} new messages — ${last.body}`,
        `msg:${peer}`, // one banner per conversation, replaced rather than stacked
      )
    }
    if (changed) saveWatermarks(marks)
    setUnread(counts)

    // ---- knocks ---------------------------------------------------------------------------
    // Knocks arrive at a relay, not in the conversation store, so nothing else would ever
    // surface them. Silent on failure: a knock check must not break the inbox.
    let open: OpenedKnock[] = []
    try {
      const state = await backend.knockState()
      setKnockState(state)
      open = state === 'armed' ? await backend.pendingKnocks() : []
      setKnocks(open)
    } catch (e) {
      console.warn('[lortnoc] knock check failed:', e)
    }

    const announced = loadAnnouncedKnocks()
    const unannounced = open.filter((k) => !announced.includes(k.id))
    if (unannounced.length) {
      for (const k of unannounced) {
        void notify(
          `${k.from ? shortHandle(k.from) : 'Someone'} answered your question`,
          k.intro || 'They want to connect.',
          `knock:${k.id}`,
        )
      }
      saveAnnouncedKnocks([...announced, ...unannounced.map((k) => k.id)])
    }

    const totalUnread = Object.values(counts).reduce((a, b) => a + b, 0)
    setBadge(totalUnread + open.filter((k) => !dismissed.includes(k.id)).length)
  }, [backend, identity, dismissed])

  // Poll (Walrus is a durable log, not a bus — §6.4). The OPEN thread refreshes on its own at a
  // faster cadence; this pass walks every conversation plus the knock relay, so running it as
  // often just queued work faster than it completed.
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 8000)
    // Background tabs get their timers throttled to roughly once a minute, so coming back to the
    // tab would otherwise show a minute-old inbox. Re-poll the moment it is looked at.
    const onVisible = () => document.visibilityState === 'visible' && void refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      setBadge(0) // leaving the messenger must not strand a count in the title bar
    }
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

  /** Opening a thread acknowledges it. Done here rather than only in the poll so the unread dot
   *  clears on the click, not up to eight seconds later. */
  function openPeer(peer: string) {
    setActive(peer)
    setMobileThread(true)
    const conv = convos.find((c) => shortHandle(c.peer) === peer)
    if (conv) {
      const newest = newestInbound(conv, identity?.handle ?? '')
      if (newest) {
        const marks = loadWatermarks() ?? {}
        marks[conv.peer] = newest.ts
        saveWatermarks(marks)
      }
      setUnread((u) => {
        const { [conv.peer]: _gone, ...rest } = u
        return rest
      })
    }
  }
  /** Open a conversation with a handle — but only once we know the handle EXISTS.
   *
   *  It used to open a thread for any string you typed. A typo produced a normal-looking empty
   *  conversation that accepted a message and only failed at send time, several seconds later,
   *  with a resolver error — by which point it reads as "this app is broken" rather than "that
   *  name does not exist". Resolving first costs one lookup and turns it into a typo. */
  async function startNew(e: React.FormEvent) {
    e.preventDefault()
    const h = newTo.trim().toLowerCase().replace(/^@/, '')
    if (!h) return
    setNewErr('')
    setChecking(true)
    try {
      const full = fullHandle(h)
      const pub = await backend.resolvePubkey(full)
      if (!pub) {
        setNewErr(`${full} has not claimed a handle yet — nothing to message.`)
        return
      }
      setNewTo('')
      openPeer(shortName(h))
      void refresh()
    } catch (err) {
      // A lookup that FAILED is not a handle that does not exist, and saying so would send
      // someone chasing a typo that is not there.
      setNewErr(`could not check that handle — ${String((err as Error)?.message ?? err).slice(0, 90)}`)
    } finally {
      setChecking(false)
    }
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
            onChange={(e) => {
              setNewTo(e.target.value)
              setNewErr('')
            }}
            disabled={checking}
          />
          {/* A bare input in a form with no button tells you nothing about how to use it. */}
          <div className="mono mgr__hint" style={newErr ? { color: '#f0806a' } : undefined}>
            {checking ? 'checking that handle…' : newErr || 'press ↵ to start a conversation'}
          </div>
        </form>
        {/* The permission prompt has to come from a click — Safari and iOS reject a bare
            requestPermission() on load — so it lives here as a row you dismiss by answering it. */}
        {perm === 'default' && (
          <button
            className="mgr__notify"
            onClick={async () => {
              const p = await requestNotify()
              setPerm(p)
              if (p === 'granted') void notify('Notifications on', 'This device will tell you when someone reaches you.', 'welcome')
            }}
          >
            <span className="signal">turn on notifications</span>
            <span>so this device tells you when a message or knock arrives</span>
          </button>
        )}
        {perm === 'denied' && (
          <div className="mgr__notify" style={{ cursor: 'default' }}>
            <span style={{ color: 'var(--muted)' }}>notifications blocked</span>
            <span>unread counts still show in the tab title — re-allow in your browser's site settings</span>
          </div>
        )}
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
          {convos.length === 0 && !inboxErr && (
            <div className="mono" style={{ color: 'var(--faint)', fontSize: 12, padding: 16, lineHeight: 1.6 }}>
              No conversations yet. Type a <span className="signal">handle</span> above to start one.
            </div>
          )}
          {convos.length === 0 && !!inboxErr && (
            // An inbox that could not be READ must never be presented as an inbox that is EMPTY.
            // The distinction is the whole difference between "nobody has messaged you" and
            // "this device cannot see your messages", and only one of those is your fault.
            <div className="mono" style={{ fontSize: 12, padding: 16, lineHeight: 1.6 }}>
              <div style={{ color: '#f0806a' }}>Could not read your conversations.</div>
              <div style={{ color: 'var(--faint)', marginTop: 6, wordBreak: 'break-word' }}>{inboxErr}</div>
              <div style={{ color: 'var(--faint)', marginTop: 6 }}>
                Your messages are on chain and encrypted to your key — this is a read failure on this
                device, not lost data. It retries on the next poll.
              </div>
            </div>
          )}
          {/* Most recently active first — the order every messenger uses, and the one thing that
              makes a list of chats feel like an inbox rather than a directory. listConversations()
              returns them in discovery order (a Set of peers), which is stable but arbitrary: a
              conversation you are actively in would sit wherever it happened to be found, and a
              reply that just arrived moved nothing. Sorted here rather than in the backend so the
              order is correct even for a conversation added optimistically by this component.
              Conversations with no messages sort last (updatedAt 0); that is fine, because the one
              you just started by typing a handle is opened as `active` regardless of its row. */}
          {[...convos]
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .map((c) => {
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
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
                    {relativeTime(c.updatedAt)}
                  </span>
                  {/* The signal that survives a declined permission prompt and a backgrounded tab. */}
                  {!!unread[c.peer] && <span className="mgr__unread mono">{unread[c.peer]}</span>}
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
    .mgr__hint { font-size:10px; color:var(--faint); padding-top:6px; line-height:1.5; }
    .mgr__list { flex:1; overflow-y:auto; min-height:0; }
    .mgr__row { width:100%; display:flex; gap:12px; align-items:center; padding:13px var(--shell); background:none; border:0; border-bottom:1px solid var(--rule); color:var(--ink); cursor:pointer; text-align:left; }
    .mgr__row:hover { background:var(--panel); }
    .mgr__row[data-active="true"] { background:var(--panel); box-shadow:inset 2px 0 0 var(--signal); }
    .mgr__unread { flex:none; min-width:20px; height:20px; padding:0 6px; border-radius:10px; background:var(--signal); color:var(--on-signal); font-size:11px; font-weight:600; display:grid; place-items:center; }
    .mgr__notify { width:100%; display:flex; flex-direction:column; gap:2px; align-items:flex-start; text-align:left; padding:10px var(--shell); border:0; border-bottom:1px solid var(--rule); background:var(--signal-soft); color:var(--muted); font-family:var(--mono); font-size:11px; line-height:1.5; cursor:pointer; }
    .mgr__notify:hover { background:var(--signal-soft); }
    .mgr__knocks { border-bottom:1px solid var(--rule); background:var(--signal-soft); }
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
