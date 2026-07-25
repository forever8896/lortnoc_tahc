import { useCallback, useEffect, useState } from 'react'
import { createWalletClient, custom, type Address, type Hex } from 'viem'
import { Eyebrow, Spinner } from './atoms'
import { arbitrum, base, mainnet, optimism } from 'viem/chains'
import {
  DUST, fundedSources, isBridgeSource, quoteToZeroG, waitForBridge, ZEROG_CHAIN_ID,
  type BridgeQuote,
} from '../lib/live/lifi'
import {
  balanceOn0G, fmt0G, join, memberCount, membershipReady, price, usdPerZeroG, zeroGChain,
} from '../lib/live/membership'

/** Founding cohort size. While `memberCount` is under this, the launch price applies. */
const FOUNDING_SLOTS = 100n
/** What membership costs once the founding cohort is gone. */
const STANDARD_USD = 50

type Step = 'check' | 'bridge' | 'bridging' | 'pay' | 'paying' | 'done'

/**
 * Two transactions, no jargon:
 *   1. bridge ~$1 of ETH from whatever chain you're on → native 0G  (~12s, via LI.FI)
 *   2. pay for membership on 0G
 *
 * We show a dollar figure throughout, because "5.67 0G" means nothing to a new user.
 */
export function Membership({ ms, onPaid }: { ms: Uint8Array | null; onPaid: () => void }) {
  const [step, setStep] = useState<Step>('check')
  const [account, setAccount] = useState<Address | null>(null)
  const [balance, setBalance] = useState<bigint>(0n)
  const [cost, setCost] = useState<bigint | null>(null)
  const [usd, setUsd] = useState<number | null>(null)
  const [quote, setQuote] = useState<BridgeQuote | null>(null)
  const [members, setMembers] = useState<bigint | null>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  const dollars = (wei: bigint) => (usd ? `$${((Number(wei) / 1e18) * usd).toFixed(2)}` : null)

  const refresh = useCallback(async () => {
    setErr('')
    try {
      const eth = (window as unknown as { ethereum?: Parameters<typeof custom>[0] }).ethereum
      if (!eth) throw new Error('No wallet found — install MetaMask.')
      const client = createWalletClient({ chain: zeroGChain, transport: custom(eth) })
      const [addr] = await client.requestAddresses()
      setAccount(addr)

      const [bal, p, rate, n] = await Promise.all([
        balanceOn0G(addr), price(), usdPerZeroG(), memberCount(),
      ])
      setBalance(bal)
      setCost(p)
      setUsd(rate)
      setMembers(n)
      setStep(bal >= p ? 'pay' : 'bridge')
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }, [])

  useEffect(() => {
    if (membershipReady()) void refresh()
  }, [refresh])

  // ---- step 1: bridge ------------------------------------------------------------------------
  async function bridge() {
    if (!account || !cost) return
    setErr('')
    setStep('bridging')
    try {
      const eth = (window as unknown as { ethereum?: Parameters<typeof custom>[0] }).ethereum
      if (!eth) throw new Error('No wallet found.')
      const client = createWalletClient({ transport: custom(eth) })
      let fromChain = await client.getChainId()
      if (fromChain === ZEROG_CHAIN_ID) {
        setErr('You are already on 0G — switch your wallet to Ethereum, Base or Arbitrum to bridge from.')
        setStep('bridge')
        return
      }

      // Signing in leaves the wallet on Sepolia (that is where ENS v2 identity lives), and no
      // bridge routes testnet value — LI.FI rejects the chain id outright. So before quoting,
      // move to a real chain this wallet can actually pay from: the one it holds the most gas on.
      if (!isBridgeSource(fromChain)) {
        setNote('finding a chain you hold ETH on…')
        const sources = await fundedSources(account)
        const best = sources.find((c) => c.balance > DUST)
        if (!best) {
          throw new Error(
            'No ETH found on Base, Arbitrum, Optimism or Ethereum. Bridging pays for membership ' +
              'with real funds, so top one of those up (about $1.50 covers membership and gas) ' +
              'and press Bridge again.',
          )
        }
        setNote(`switching your wallet to ${best.name}…`)
        await switchTo(client, best.id)
        fromChain = best.id
      }

      // Bridge enough for the membership plus headroom for the two 0G transactions.
      const target = ((cost - balance) * 145n) / 100n
      setNote('finding the cheapest route…')
      const q = await quoteToZeroG({
        fromChain,
        fromAddress: account,
        // The quote is denominated in the SOURCE chain's gas token, so ask LI.FI how much ETH
        // produces the 0G we need by quoting a nominal amount and scaling.
        fromAmountWei: await ethNeededFor(target, fromChain, account),
      })
      setQuote(q)

      setNote(`bridging ${q.fromAmountUSD ? `$${Number(q.fromAmountUSD).toFixed(2)}` : ''} via ${q.tool} — confirm in your wallet`)
      const hash = await client.sendTransaction({
        account, chain: null, to: q.tx.to, data: q.tx.data, value: q.tx.value,
      })

      setNote(`sent — waiting for 0G to credit (usually ~${q.durationSeconds || 15}s)`)
      const status = await waitForBridge(hash as Hex, fromChain, {
        onTick: (s, ms_) => setNote(`bridge ${s.toLowerCase()} — ${Math.round(ms_ / 1000)}s`),
      })
      if (status === 'FAILED') throw new Error('the bridge reported a failure — funds stay on the source chain')

      setNote('bridged. checking your 0G balance…')
      await refresh()
      setStep('pay')
      setNote('')
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
      setStep('bridge')
    }
  }

  /** Ask the wallet to move chains, adding the network first if it has never seen it. */
  async function switchTo(client: ReturnType<typeof createWalletClient>, id: number) {
    const known = [base, arbitrum, optimism, mainnet].find((c) => c.id === id)
    try {
      await client.switchChain({ id })
    } catch (e) {
      if (!known) throw e
      await client.addChain({ chain: known })
      await client.switchChain({ id })
    }
  }

  /** How much source-chain ETH yields `want` wei of 0G — quote a probe and scale up. */
  async function ethNeededFor(want: bigint, fromChain: number, addr: Address): Promise<bigint> {
    const probe = 600_000_000_000_000n // ~$1.12 of ETH
    const q = await quoteToZeroG({ fromChain, fromAddress: addr, fromAmountWei: probe })
    if (q.toAmount === 0n) return probe
    // +12% so slippage or a price tick doesn't leave the user a few cents short.
    const needed = (probe * want * 112n) / (q.toAmount * 100n)
    return needed > probe / 4n ? needed : probe / 4n
  }

  // ---- step 2: pay ---------------------------------------------------------------------------
  async function pay() {
    if (!ms) {
      setErr('connect and sign first — your membership secret is derived from that signature')
      return
    }
    setErr('')
    setStep('paying')
    try {
      const { commitmentFrom } = await import('../lib/live/membership')
      const commitment = await commitmentFrom(ms)
      setNote('confirm the payment in your wallet…')
      await join(commitment)
      setStep('done')
      setNote('')
      onPaid()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
      setStep('pay')
    }
  }

  if (!membershipReady()) {
    return (
      <Card>
        <Eyebrow>Membership</Eyebrow>
        <p style={{ color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
          The membership contract is not deployed yet. Handles are free while it is unset.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Eyebrow signal>Membership</Eyebrow>
        <span className="chip mono" style={{ fontSize: 10 }}>0G mainnet</span>
      </div>

      <Price cost={cost} dollars={dollars} members={members} />
      <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.65 }}>
        Buys your handle and the storage your messages live in. Paid anonymously: the payment and
        the handle are never linked on-chain.
      </p>

      <Steps step={step} />

      {step === 'bridge' && (
        <>
          <Row label="you have" value={`${fmt0G(balance)}${dollars(balance) ? ` (${dollars(balance)})` : ''}`} />
          <Row label="you need" value={cost ? `${fmt0G(cost)}${dollars(cost) ? ` (${dollars(cost)})` : ''}` : '—'} />
          <button className="btn" onClick={bridge}>Bridge ~$1 of ETH → 0G</button>
          <Hint>
            One transaction from Ethereum, Base, Arbitrum or Optimism — we'll switch your wallet
            to whichever of those you hold ETH on, since sign-in leaves it on Sepolia. Takes about
            12 seconds. Your wallet stays in control the whole way.
          </Hint>
        </>
      )}

      {step === 'bridging' && (
        <Busy>
          {note || 'bridging…'}
          {quote && <div className="mono" style={{ fontSize: 11, marginTop: 6, color: 'var(--faint)' }}>
            via {quote.tool} · ~{quote.durationSeconds}s · gas ≈ ${quote.gasCostUSD}
          </div>}
        </Busy>
      )}

      {step === 'pay' && (
        <>
          <Row label="your 0G balance" value={`${fmt0G(balance)}${dollars(balance) ? ` (${dollars(balance)})` : ''}`} ok />
          <Row label="membership" value={cost ? fmt0G(cost) : '—'} />
          <button className="btn" onClick={pay}>Pay for membership</button>
          <Hint>
            This inserts your membership secret into the paid set. It never reveals which handle
            you will claim — that link is broken by the proof you generate next.
          </Hint>
        </>
      )}

      {step === 'paying' && <Busy>{note || 'paying…'}</Busy>}

      {step === 'done' && (
        <div className="mono" style={{ color: 'var(--signal)', fontSize: 13, lineHeight: 1.7 }}>
          ✓ You're a member. Pick your handle next — it will be issued by a relayer, so nothing
          connects it to the wallet that just paid.
        </div>
      )}

      {step === 'check' && <Busy>reading your balance…</Busy>}
      {err && <ErrBox>{err}</ErrBox>}
    </Card>
  )
}

// ---- bits ---------------------------------------------------------------------------------

/** Launch pricing. The slot count is read from the contract's `memberCount`, so the number
 *  shown is the real one — if it ever stops being true, it stops being shown. */
function Price({
  cost, dollars, members,
}: {
  cost: bigint | null
  dollars: (w: bigint) => string | null
  members: bigint | null
}) {
  const founding = members === null || members < FOUNDING_SLOTS
  const left = members === null ? null : Number(FOUNDING_SLOTS - members)
  const now = cost && dollars(cost) ? dollars(cost) : '$1'

  if (!founding) {
    return (
      <h2 style={{ margin: '4px 0 0', fontWeight: 400, fontSize: 30, letterSpacing: '-0.02em' }}>
        {now} — once.
      </h2>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span
          className="mono"
          style={{ fontSize: 16, color: 'var(--faint)', textDecoration: 'line-through' }}
        >
          ${STANDARD_USD}
        </span>
        <span style={{ fontWeight: 400, fontSize: 34, letterSpacing: '-0.02em' }}>{now}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--signal)' }}>
          worth of ETH — once
        </span>
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--signal)' }}>
        founding price · {left === null ? 'first 100 members' : `${left} of ${FOUNDING_SLOTS} left`}
      </div>
      <div className="mono" style={{ fontSize: 10, color: 'var(--faint)', lineHeight: 1.6 }}>
        ${STANDARD_USD} from member {Number(FOUNDING_SLOTS) + 1} onward.
      </div>
    </div>
  )
}

function Steps({ step }: { step: Step }) {
  const done = (s: Step[]) => s.includes(step)
  const items: [string, boolean, boolean][] = [
    ['Bridge $1 to 0G', done(['pay', 'paying', 'done']), done(['bridge', 'bridging'])],
    ['Pay for membership', done(['done']), done(['pay', 'paying'])],
  ]
  return (
    <div style={{ display: 'flex', gap: 10, margin: '2px 0' }}>
      {items.map(([label, complete, active], i) => (
        <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 2, background: complete ? 'var(--signal)' : active ? 'var(--muted)' : 'var(--rule)' }} />
          <div className="mono" style={{ fontSize: 10, color: complete ? 'var(--signal)' : active ? 'var(--fg)' : 'var(--faint)' }}>
            {complete ? '✓' : `${i + 1}.`} {label}
          </div>
        </div>
      ))}
    </div>
  )
}

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="card" style={{ padding: 26, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 }}>
    {children}
  </div>
)

const Row = ({ label, value, ok }: { label: string; value: string; ok?: boolean }) => (
  <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
    <span style={{ color: 'var(--faint)' }}>{label}</span>
    <span style={{ color: ok ? 'var(--signal)' : 'var(--muted)' }}>{value}</span>
  </div>
)

const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className="mono" style={{ margin: 0, fontSize: 11, color: 'var(--faint)', lineHeight: 1.65 }}>{children}</p>
)

const Busy = ({ children }: { children: React.ReactNode }) => (
  <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Spinner /> <span>{children}</span>
  </div>
)

const ErrBox = ({ children }: { children: React.ReactNode }) => (
  <div className="mono" style={{ fontSize: 11, lineHeight: 1.6, padding: '10px 12px', border: '1px solid rgba(240,128,106,0.35)', color: '#f0806a', wordBreak: 'break-word' }}>
    {children}
  </div>
)
