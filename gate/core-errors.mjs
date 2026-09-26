/** An error carrying the HTTP status gate/server.mjs should answer with. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}
