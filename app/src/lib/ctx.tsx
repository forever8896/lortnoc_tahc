import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Backend } from './backend'
import { MockBackend } from './mock'
import { LiveBackend } from './live'
import type { Identity } from './types'

type Ctx = { backend: Backend; identity: Identity | null; setIdentity: (i: Identity | null) => void }
const BackendCtx = createContext<Ctx | null>(null)

export function BackendProvider({ children }: { children: ReactNode }) {
  // LIVE IS THE DEFAULT: real wallet signature, real membership payment on 0G mainnet, real ENS
  // handle on Sepolia, real Sui/Walrus store. The deployed product is the product.
  //
  // `?mock` opts back down to the offline demo (real crypto, localStorage transport, no chain) —
  // kept for development and for showing the UI without spending anything. `?live` still works
  // so older links and the docs' instructions don't break.
  const backend = useMemo<Backend>(() => {
    const q = new URLSearchParams(location.search)
    return q.has('mock') && !q.has('live') ? new MockBackend() : new LiveBackend()
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
