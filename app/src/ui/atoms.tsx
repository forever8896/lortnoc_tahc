import type { ReactNode } from 'react'
import { HANDLE_SUFFIX } from '../lib/backend'

export function Wordmark({ small }: { small?: boolean }) {
  return <img src="/logo.png" alt="lortnoctahc" style={{ height: small ? 42 : 72, width: 'auto', display: 'block' }} />
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

/**
 * Render message text with http(s) links made clickable.
 *
 * Built by SPLITTING the string and returning React nodes — never `dangerouslySetInnerHTML`.
 * Message bodies are attacker-controlled: anyone who can message you can put a string in here,
 * and injecting it as HTML would hand them script execution in a page holding your keys.
 *
 * Only http/https are linked. `javascript:` and `data:` URLs are the reason that is a whitelist
 * and not a blacklist, and everything unmatched stays plain text.
 */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g)
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            // noreferrer implies noopener, but both are stated: this opens an attacker-supplied
            // URL from a page that holds the user's keys, so the new tab gets no handle back.
            rel="noreferrer noopener"
            style={{ color: 'var(--signal)', textDecoration: 'underline', wordBreak: 'break-word' }}
            onClick={(e) => e.stopPropagation()} // the bubble itself is a toggle
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  )
}
