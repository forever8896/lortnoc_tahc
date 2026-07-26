import { useCallback, useEffect, useState } from 'react'
import { useBackend } from '../lib/ctx'
import type { EnsStatus, OpenedKnock, RecordPerm } from '../lib/types'
import { RECORD_SPECS } from '../lib/live/config'
import { Eyebrow, Spinner, shortHandle } from './atoms'

/**
 * Your identity, and the records that make it up.
 *
 * The point of this panel is that every row is a *live* reading, not a description: each "write"
 * cell is an `eth_call` against the real authorisation path on your own resolver. If the chain
 * disagrees with us, the chain wins and you see it here.
 */
export function IdentityPanel({ onClose }: { onClose: () => void }) {
  const { backend, identity, setIdentity } = useBackend()
  const [status, setStatus] = useState<EnsStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await backend.ensStatus())
    } catch (e) {
      setErr(msg(e))
    }
  }, [backend])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Every mutation goes through here so the panel always re-reads the chain afterwards — a
   *  stale table is worse than no table when the whole claim is "these permissions are real". */
  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label)
    setErr('')
    setNote('')
    try {
      setNote(await fn())
      await refresh()
    } catch (e) {
      setErr(msg(e))
    } finally {
      setBusy('')
    }
  }

  const live = status?.live ?? false

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 660, padding: 26, display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '92dvh', overflowY: 'auto' }}
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
          <Field label="owns this handle (derived from your key)" value={identity!.ownerAddress} />
          {identity!.address.toLowerCase() !== identity!.ownerAddress.toLowerCase() && (
            <>
              <Field label="wallet you connected / paid with" value={identity!.address} />
              <div className="mono" style={{ fontSize: 11, color: 'var(--signal)', marginTop: 6, lineHeight: 1.6 }}>
                ✓ two different addresses — nothing on-chain links the payment to this handle
              </div>
            </>
          )}
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

        <hr className="rule" />

        <Records status={status} busy={busy} live={live} run={run} gateway={status?.gateway ?? ''} />

        <hr className="rule" />

        <ExtensionUnlock busy={busy} run={run} />

        <hr className="rule" />

        <Knock status={status} busy={busy} run={run} />

        {note && <Note>{note}</Note>}
        {err && <Note bad>{err}</Note>}

        <hr className="rule" />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void refresh()}>
            re-read chain
          </button>
          {status?.explorer && (
            <a className="btn btn--ghost btn--sm" href={status.explorer} target="_blank" rel="noreferrer">
              resolver on Etherscan ↗
            </a>
          )}
          <button
            className="btn btn--ghost btn--sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              sessionStorage.clear()
              setIdentity(null)
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- records ----------------------------------------------------------------------------------

type RunFn = (label: string, fn: () => Promise<string>) => Promise<void>

/**
 * Who may write this record, as a sentence.
 *
 * This replaces two cryptic cells ("you write" / "gateway —") that sat inline with the edit and
 * delegate buttons. They were live `eth_call` readouts, but next to real controls they read as
 * commands, so the most important claim on the screen — that permissions are per-record and
 * enforced by the chain — was the least legible thing on it.
 */
function PermissionLine({ perm, gateway }: { perm?: RecordPerm; gateway: string }) {
  const you = perm?.ownerCanWrite ?? false
  const gw = perm?.gatewayCanWrite ?? false
  const who = gateway ? `${gateway.slice(0, 6)}…${gateway.slice(-4)}` : 'the gateway'

  const [mark, text, color] = you && gw
    ? ['⚠', `You — and ${who} — can write this`, '#ffb26b']
    : you
      ? ['✓', 'Only you can write this', 'var(--signal)']
      : gw
        ? ['✕', `You cannot write this — only ${who} can`, '#f0806a']
        : ['·', 'Nobody can write this', 'var(--faint)']

  return (
    <div className="mono" style={{ fontSize: 11, color, marginTop: 5 }}>
      {mark} {text}
    </div>
  )
}

/** The admin table. One row per record, with what it holds, who may write it, and the controls
 *  to change either. */
function Records({
  status, busy, live, run, gateway,
}: {
  status: EnsStatus | null
  busy: string
  live: boolean
  run: RunFn
  gateway: string
}) {
  const { backend } = useBackend()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  if (!status) return <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>reading chain…</div>

  const permFor = (key: string) => status.perms.find((p) => p.key === key)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Eyebrow>Records — who is allowed to write each one</Eyebrow>
        <span className="chip mono" style={{ fontSize: 10 }}>{live ? 'Sepolia · on-chain' : 'demo mode'}</span>
      </div>

      <div style={{ border: '1px solid var(--rule)' }}>
        {RECORD_SPECS.map((spec, i) => {
          const perm = permFor(spec.key)
          const short = spec.key.replace('eth.lortnoc.', '')
          const delegated = perm?.gatewayCanWrite ?? false
          return (
            <div key={spec.key} style={{ borderTop: i ? '1px solid var(--rule)' : undefined, padding: '10px 12px' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 12, minWidth: 92 }}>{short}</span>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: perm?.value ? 'var(--muted)' : 'var(--faint)', flex: 1, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={perm?.value ?? ''}
                >
                  {perm?.value ?? 'unset'}
                </span>
              </div>

              <div className="mono" style={{ fontSize: 10, color: 'var(--faint)', marginTop: 4 }}>{spec.hint}</div>
              <PermissionLine perm={perm} gateway={gateway} />

              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {spec.owned && (
                  <button
                    className="btn btn--ghost btn--sm"
                    disabled={!!busy}
                    onClick={() => {
                      setEditing(editing === spec.key ? null : spec.key)
                      setDraft(perm?.value ?? '')
                    }}
                  >
                    {editing === spec.key ? 'cancel' : 'edit'}
                  </button>
                )}
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={!!busy || !gateway}
                  onClick={() =>
                    run(spec.key, () => backend.delegateRecord(spec.key, gateway, !delegated))
                  }
                >
                  {busy === spec.key ? <Spinner /> : null}
                  {delegated ? 'revoke gateway access' : 'let the gateway write this'}
                </button>
              </div>

              {editing === spec.key && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <input
                    className="input mono"
                    style={{ flex: 1, fontSize: 11 }}
                    value={draft}
                    autoFocus
                    placeholder={spec.hint}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button
                    className="btn btn--sm"
                    disabled={!!busy}
                    onClick={async () => {
                      await run(spec.key, () => backend.setRecord(spec.key, draft))
                      setEditing(null)
                    }}
                  >
                    save
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="mono" style={{ fontSize: 10, color: 'var(--faint)', lineHeight: 1.65 }}>
        {live
          ? 'each write cell is simulated against your live resolver · delegation grants ROLE_SET_TEXT on that record ONLY, revocable in one tx'
          : 'demo mode — the live app measures these on-chain'}
        <br />
        Roles gate <span className="signal">writes</span>, never reads: every record here is
        world-readable. Read-gating is the offchain gateway's job.
      </div>
    </div>
  )
}

/**
 * One membership, both unlocks: the 0G payment that bought this handle also lifts the codec's
 * free-send limit inside the Telegram extension.
 *
 * The token used to be handed over exactly once, by postMessage, at the instant of claiming — so
 * if the extension was not installed and listening on this page in that moment, it was gone and
 * the only recourse was paying again. Now it is stored, re-offered on load, and re-issuable.
 */
function ExtensionUnlock({ busy, run }: { busy: string; run: RunFn }) {
  const { backend } = useBackend()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Eyebrow>Telegram extension</Eyebrow>
      <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
        Your membership also unlocks unlimited hidden messages in Telegram — no second payment.
        Install the extension, open this page, and hit unlock.
      </div>
      <div>
        <button
          className="btn btn--ghost btn--sm"
          disabled={!!busy}
          onClick={() =>
            run('unlock', async () => {
              const r = await backend.unlockExtension()
              if (r === 'unlocked') return 'Extension unlocked — the free-send limit is lifted in Telegram.'
              if (r === 'no-extension')
                return 'No extension answered on this page. Install it, reload, and try again.'
              return 'No paid membership found for this handle — the codec stays on the free tier.'
            })
          }
        >
          {busy === 'unlock' ? <Spinner /> : null} Unlock the extension
        </button>
      </div>
    </div>
  )
}

// ---- knock ------------------------------------------------------------------------------------

/** Challenge-gated contact (§6.8). You publish a question; the answer never leaves this device. */
function Knock({ status, busy, run }: { status: EnsStatus | null; busy: string; run: RunFn }) {
  const { backend } = useBackend()
  const [prompt, setPrompt] = useState('')
  const [answer, setAnswer] = useState('')
  const [checkAnswer, setCheckAnswer] = useState('')
  const [opened, setOpened] = useState<OpenedKnock[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [knockErr, setKnockErr] = useState('')

  const current = status?.perms.find((p) => p.key.endsWith('knock'))?.value
  const parsed = safeParse(current)

  async function check() {
    setChecking(true)
    setKnockErr('')
    setOpened(null)
    try {
      setOpened(await backend.readKnocks(checkAnswer))
    } catch (e) {
      setKnockErr(msg(e))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Eyebrow>Knock — who is allowed to reach you</Eyebrow>
      <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
        Publish a question only the right people can answer. Nobody can even notify you without
        clearing it — a wrong answer is dropped silently, and you are never told it happened.
        <br />
        <span style={{ color: 'var(--faint)' }}>
          The answer is never published, sent, or stored. Only the question goes on-chain, so there
          is nothing to brute-force offline — guessing is online-only and rate-limited.
        </span>
      </div>

      {parsed && (
        <div className="mono" style={{ fontSize: 11, padding: '8px 10px', border: '1px solid var(--rule)' }}>
          <span style={{ color: 'var(--faint)' }}>currently asking:</span>{' '}
          <span className="signal">“{parsed.prompt}”</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          className="input mono"
          style={{ fontSize: 12 }}
          placeholder={parsed ? 'new question…' : 'e.g. what bar did we meet at?'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input mono"
            style={{ flex: 1, fontSize: 12 }}
            placeholder="the answer (stays on this device)"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button
            className="btn btn--sm"
            disabled={!!busy || !prompt.trim() || !answer.trim()}
            onClick={async () => {
              await run('knock', () => backend.setKnock(prompt, answer))
              setPrompt('')
              setAnswer('')
            }}
          >
            {busy === 'knock' ? <Spinner /> : null} publish
          </button>
        </div>
      </div>

      {parsed && (
        <>
          <div className="mono" style={{ fontSize: 10, color: 'var(--faint)', marginTop: 4 }}>
            Check who has knocked. Deriving the key takes ~1s — that cost is what makes guessing
            expensive for everyone else too.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input mono"
              style={{ flex: 1, fontSize: 12 }}
              placeholder="your answer"
              value={checkAnswer}
              onChange={(e) => setCheckAnswer(e.target.value)}
            />
            <button className="btn btn--ghost btn--sm" disabled={checking || !checkAnswer.trim()} onClick={check}>
              {checking ? <Spinner /> : null} check knocks
            </button>
          </div>

          {opened !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {opened.length === 0 ? (
                <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
                  Nothing opened. Either nobody has knocked, or nobody answered correctly — from
                  here those look the same, deliberately.
                </div>
              ) : (
                opened.map((k) => (
                  <div key={k.id} style={{ border: '1px solid var(--rule)', padding: '8px 10px' }}>
                    <div className="mono" style={{ fontSize: 12 }}>
                      <span className="signal">{k.from ?? 'someone'}</span> wants to connect
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>“{k.intro}”</div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--faint)', marginTop: 4, wordBreak: 'break-all' }}>
                      key {k.pubkey} · {new Date(k.ts).toLocaleString()}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      {knockErr && <Note bad>{knockErr}</Note>}
      <div className="mono" style={{ fontSize: 10, color: 'var(--faint)', lineHeight: 1.6 }}>
        Honest limit: trivia is low-entropy. This is spam-resistance and intentional contact, not
        cryptographic access control. Use a high-entropy shared password if you need real secrecy.
      </div>
    </div>
  )
}

// ---- bits -------------------------------------------------------------------------------------

const msg = (e: unknown) => String(e instanceof Error ? e.message : e)

function safeParse(raw: string | null | undefined): { prompt: string } | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { prompt?: string }
    return v.prompt ? { prompt: v.prompt } : null
  } catch {
    return null
  }
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
