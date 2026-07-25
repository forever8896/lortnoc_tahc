import { useBackend } from './lib/ctx'
import { Auth } from './ui/Auth'
import { Claim } from './ui/Claim'
import { Messenger } from './ui/Messenger'

export function App() {
  const { identity } = useBackend()
  if (!identity) return <Auth />
  if (!identity.handle) return <Claim />
  return <Messenger />
}
