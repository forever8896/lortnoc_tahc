// Hand the codec membership token to the browser extension (if installed). The extension's
// content script on this origin listens for this postMessage and stores the token, so the
// SAME 0G membership that bought the handle also unlocks unlimited codec use in Telegram —
// one payment, both unlocks. No-op if the extension isn't present (nothing listening).
export function deliverMembershipToExtension(token: string): void {
  try {
    window.postMessage({ source: 'lortnoc-app', type: 'MEMBERSHIP', token }, window.location.origin)
  } catch {
    // no extension / postMessage blocked — the token is still returned to the app UI to show
  }
}
