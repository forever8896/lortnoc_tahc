import type { ReactNode } from 'react'
import { HANDLE_SUFFIX } from '../lib/backend'

export function Wordmark({ small }: { small?: boolean }) {
  return <img src="/logo.png" alt="lortnoctahc" style={{ height: small ? 26 : 44, width: 'auto', display: 'block' }} />
}

export function Eyebrow({ children, signal }: { children: ReactNode; signal?: boolean }) {
  return <div className="eyebrow" style={signal ? { color: 'var(--signal)' } : undefined}>{children}</div>
}

export function Spinner() {
  return <span className="spin">◠</span>
}

/** Avatar from a handle — deterministic signal-tinted monogram. */
export function Avatar({ handle, size = 38 }: { handle: string; size?: number }) {
  const letter = (handle[0] || '?').toUpperCase()
  const hue = [...handle].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        flex: '0 0 auto',
        background: `hsl(${hue} 30% 14%)`,
        color: 'var(--ink)',
        fontFamily: 'var(--mono)',
        fontSize: size * 0.4,
        border: '1px solid var(--rule)',
      }}
    >
      {letter}
    </div>
  )
}

export function shortHandle(h: string): string {
  return h.replace(HANDLE_SUFFIX, '')
}
