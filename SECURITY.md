# Security

## Reporting

Email **kilianvaldman@gmail.com** with `SECURITY` in the subject, or use GitHub's
[private vulnerability reporting](https://github.com/forever8896/lortnoc_tahc/security/advisories/new).

Please don't open a public issue for anything exploitable. We'll acknowledge within a few days.

There is no bug bounty. This is a small project run by a couple of people, and pretending otherwise
would waste your time.

## Scope and status

**This software is in closed alpha and has not been independently audited.** Do not use it for
anything you would be harmed by losing or by having exposed. The contracts were written quickly and
carry the limitations catalogued under [Known limits](README.md#known-limits) in the README — that
list is deliberately honest, and it is the right place to start if you are looking for weak points.

Particularly worth knowing before you report:

- **The in-band handshake is trust-on-first-use.** There is no active-MITM protection on the first
  key exchange inside Telegram. This is a known design limit of the free path, not a bug.
- **There is no forward secrecy.** Compromising a long-term messaging key exposes past
  conversations derived from it.
- **The relayer is a liveness dependency.** It cannot forge or redirect a claim — the nullifier is
  burned on-chain and the claim is bound into the proof — but it can stall or censor one.
- **Free-tier metering is client-asserted** and trivially bypassable by design. It is a conversion
  nudge, not an access control, and we say so in the product.

## What we consider in scope

Anything that breaks a claim the project actually makes: plaintext leaving the page, a key server
releasing a share to a non-participant, a relayer being able to redirect a claim or publish a
messaging key it controls, a handle being issued without a valid unspent nullifier once gating is
enabled, or cover text that fails to decode to the exact bytes that produced it.

## Out of scope

Missing security headers on the marketing site, rate-limiting on public read endpoints, anything
requiring a compromised device or a malicious browser extension already present, and the known
limits listed above.
