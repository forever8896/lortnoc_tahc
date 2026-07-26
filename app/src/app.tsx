import { useEffect, useState } from 'react'
import { useBackend } from './lib/ctx'
import { Auth } from './ui/Auth'
import { Claim } from './ui/Claim'
import { Membership } from './ui/Membership'
import { Messenger } from './ui/Messenger'
import { commitmentOf } from './lib/live/proof'
import { isMember, membershipReady } from './lib/live/membership'

export function App() {
  const { backend, identity } = useBackend()
  // null = still checking. Read from the membership contract, so closing the tab after paying
  // does not send you back to the paywall.
  const [member, setMember] = useState<boolean | null>(null)

  const live = backend.health().mode === 'live'
  const ms = backend.masterSecret()

  useEffect(() => {
    let alive = true
    if (!live || !membershipReady() || !ms) {
      setMember(false)
      return
    }
    void (async () => {
      try {
        const yes = await isMember(await commitmentOf(ms))
        if (alive) setMember(yes)
      } catch {
        // If 0G is unreachable we must not lock someone out of a handle they paid for.
        if (alive) setMember(true)
      }
    })()
    return () => { alive = false }
  }, [live, ms, identity])

  // Installing the extension AFTER claiming used to mean the token was unreachable. Re-offer it
  // on every load so it lands as soon as something is listening.
  useEffect(() => {
    if (identity?.handle && live) backend.redeliverCodecToken?.()
  }, [identity, live, backend])

  if (!identity) return <Auth />

  const gated = live && membershipReady() && !identity.handle && member === false
  if (gated) {
    return (
      <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 'var(--shell)' }}>
        <Membership ms={ms} onPaid={() => setMember(true)} />
      </main>
    )
  }

  if (!identity.handle) return <Claim />
  return <Messenger />
}
