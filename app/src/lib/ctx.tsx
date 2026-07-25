import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Backend } from './backend'
import { MockBackend } from './mock'
import { LiveBackend } from './live'
import type { Identity } from './types'

type Ctx = { backend: Backend; identity: Identity | null; setIdentity: (i: Identity | null) => void }
const BackendCtx = createContext<Ctx | null>(null)

export function BackendProvider({ children }: { children: ReactNode }) {
  // ?live → real ENS (Sepolia) + Sui/Walrus store; default is the fully-working mock
  // (real crypto, localStorage transport). Live needs the day-0 setup (docs/LIVE-SETUP.md).
  const backend = useMemo<Backend>(() => {
    const live = new URLSearchParams(location.search).has('live')
    return live ? new LiveBackend() : new MockBackend()
  }, [])
  const [identity, setIdentity] = useState<Identity | null>(null)

  useEffect(() => {
    setIdentity(backend.currentIdentity())
  }, [backend])

  return <BackendCtx.Provider value={{ backend, identity, setIdentity }}>{children}</BackendCtx.Provider>
}

export function useBackend(): Ctx {
  const c = useContext(BackendCtx)
  if (!c) throw new Error('useBackend outside provider')
  return c
}
