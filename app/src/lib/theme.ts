// Theme selection — four dark palettes, chosen by the reader, remembered on the device.
//
// A theme is a `data-theme` attribute on <html> and nothing else: the palettes live in
// styles.css as variable blocks, so switching one is a single attribute write with no re-render,
// no flash, and no stylesheet to load. Everything downstream already reads the variables.
//
// Stored per device, not per identity. It is a display preference, not part of who you are —
// putting it in the identity would mean it followed you to someone else's screen, and would be
// one more thing derived from a master secret for no reason.

const KEY = 'lortnoc.theme.v1'

export type ThemeId = 'signal' | 'ember' | 'iris' | 'moss'

export type Theme = {
  id: ThemeId
  name: string
  /** What it actually looks like, in one line — the swatch shows the colour, this says the feel. */
  note: string
  /** Preview swatch: [background, accent]. Kept in sync with styles.css by hand; they are two
   *  values per theme and a mismatch is visible immediately in the picker. */
  swatch: [string, string]
}

export const THEMES: Theme[] = [
  { id: 'signal', name: 'Signal', note: 'teal on near-black · sharp corners', swatch: ['#08080A', '#12c4be'] },
  { id: 'ember', name: 'Ember', note: 'amber on warm charcoal · soft corners', swatch: ['#0b0908', '#ff8a4c'] },
  { id: 'iris', name: 'Iris', note: 'violet on indigo · fully rounded', swatch: ['#08070d', '#a78bfa'] },
  { id: 'moss', name: 'Moss', note: 'lime on green-black · barely rounded', swatch: ['#070a08', '#7dd956'] },
]

const IDS = new Set(THEMES.map((t) => t.id))

/** The stored theme, or the default. Never throws: a private window with storage disabled, or a
 *  value written by an older build, must still render the app rather than blank it. */
export function currentTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY)
    if (v && IDS.has(v as ThemeId)) return v as ThemeId
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return 'signal'
}

/** Apply a theme and remember it. Applying is the attribute write; the persistence is best-effort
 *  so a storage failure costs you the memory of the choice, never the choice itself. */
export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id)
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* the theme is applied either way */
  }
}

/** Called once before React mounts, so the first paint is already in the right palette. A theme
 *  applied in an effect flashes the default first, which is the most obvious possible bug. */
export function initTheme(): void {
  document.documentElement.setAttribute('data-theme', currentTheme())
}
