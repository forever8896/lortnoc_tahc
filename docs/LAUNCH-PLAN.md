# Launch plan — converting attention into a list

**Status:** decided, implementation starting · **Written:** 2026-07-29

## Decisions (locked)

| Question | Decision |
|---|---|
| Which service pauses | **Codec only.** Relayer and 0G sidecar stay up. |
| Funnels | **Both** — waitlist (email) and alpha (Telegram). |
| Alpha cap | **None.** |
| Email opt-in | **Single opt-in.** Collect and move. See §3.4 for the one cheap mitigation. |
| GitHub releases | **Off the market** while we stabilise. See §5.1 — draft, don't delete. |
| Donation page | **Yes**, with a wallet. New §6. |

Rationale on codec-only: the app and Lortnoc DM are reached *through* the extension. With no
extension going out, nobody arrives at the claim flow anyway, so pausing the relayer would cost
availability without buying anything — and would strand anyone already mid-claim.

## The strategy in one paragraph

Today the funnel is *install this and use it*. Under a sudden spike of attention that is the
wrong funnel: it points strangers at a build we are still actively fixing, and a bad first run
costs far more than a delayed one — people try a privacy tool exactly once. The move is to
convert attention into a **list** rather than into installs, while keeping the code fully open,
because "verify, don't trust" is the entire pitch and going quiet or closed would contradict it
at the worst possible moment. We control distribution; we do not rush software.

One reframing worth adopting: **the pause is not downtime, it is the moment self-hosting becomes
the documented path.** The codec is open source and runs locally in one command. A large share of
the people arriving via a technical mention can run it themselves. That turns "the hosted service
is off" from an apology into a demonstration of the claim.

---

## Phase 0 — Do this before anything else becomes public

This is security work, and it is first because attention arrives before you are ready for it.

### 0.1 Rotate the treasury off the hot deploy key

`CHECKLIST.md:205` says publicly, in a public repo:

> ⚠️ **Treasury is currently the deploy key** (`0x61eE…1Bb8`), whose private key lives in a fly
> container env.

The address itself is unavoidable — it is on-chain. What the doc adds is the shortlist: that it
is a **hot** key, that it is the **treasury**, and **where it lives**. CLAUDE.md already says
"move it before collecting at scale". Scale is what a prominent mention produces.

- Call `setTreasury` to a cold address, then `transferOwnership` on `LortnocMembership`.
- Same for `LortnocRegistrar.owner`, which controls `setRelayer` and `setGate`.
- Then rewrite that CHECKLIST line to describe the *current* state.

Cost: two transactions. Do it before the site changes go live.

### 0.2 Decide what the public docs should say

`CLAUDE.md`, `CHECKLIST.md` and `docs/AUDIT.md` are candid internal documents in a public repo.
That candour is mostly an **asset** right now — a repo whose own audit lists its untested
components reads as honest, and the recent honesty pass on the sponsor pages compounds it. Keep
that. What to remove is narrower: anything that tells someone *where a secret lives* or *which
component is both unprotected and valuable*. Operational detail, not admissions.

---

## Phase 1 — Pause the service deliberately

### 1.1 Which service?

Your note says "the fly IO resolution server". There are three, and they do different jobs:

| Service | Kills what | Recommendation |
|---|---|---|
| `lortnoc-codec` | **The whole product.** No cover text, no send, no decode. | **This is the one to pause.** |
| `lortnoc-relayer` | Paid handle claims (0G → ENS → Sui) | Leave up — it is not the mass-market surface, and killing it strands anyone mid-claim |
| `lortnoc-zerog` | Best-of-N cover selection only | Leave up — the codec already falls back silently |

Assumed below: **pause the codec, leave the other two running.** Say if you meant the relayer.

### 1.2 Paused, not offline — and the reason is concrete

Do **not** `fly scale count 0`. A dead host produces a connection timeout, and a timeout is
indistinguishable from "my wifi is bad" or "this extension is broken". People file issues, or
worse, quietly conclude the project is abandoned. An immediate, worded response is the thing that
actually manages expectations.

Add a paused mode to `codec/server.py`:

- `CODEC_PAUSED=1` env flag, flipped with `fly secrets set` — no redeploy, instantly reversible.
- `/encode` and `/decode` → **`503`** with a JSON body carrying a human message and a URL.
  503 is correct (temporary, service-level) and is not 402, which the extension already maps to
  the paywall.
- Keep `/health` **up and returning 200**. See below — it is the only channel that reaches
  already-installed extensions.

### 1.3 The lever that reaches users who already installed 0.8.8

This is the part worth getting right, because **you cannot retroactively change what an installed
extension says.** Whatever 0.8.8 does on failure is what those users will see, forever, unless
they update.

What 0.8.8 does today with the codec down:

| Surface | What the user sees |
|---|---|
| Sending | `Encoding failed — not sent` — draft preserved, nothing leaks. Fail-closed works. |
| Popup chip | `offline` |
| Inbound | Bubbles retry quietly; no crash, no false decode |

The behaviour is safe but the wording is uninformative. There is one channel that can carry a real
message to existing installs with no update, and it is a happy accident of the popup code:

```ts
if (res.ok && res.data.ready) setChip(status, res.data.model ?? 'codec ok', true, true)
```

The popup prints `/health`'s **`model` string verbatim**. So a paused `/health` that returns
`{ ready: true, model: "paused — alpha signup at lortnoctahc.com" }` puts that sentence directly
into every installed popup. Free, immediate, no release.

Caveat to accept knowingly: `ready: true` while `/encode` 503s is internally inconsistent. It is
worth it — the alternative reaches nobody — but it should be a deliberate, commented decision in
the code, not something a future reader mistakes for a bug.

### 1.4 Then ship 0.8.9 with a real paused state

For anyone who installs *after* the change: teach the extension to recognise 503-with-`paused` and
show a proper banner ("The hosted codec is paused during the alpha — join at …, or run your own:
one command"). Small change to `background/index.ts` and `content/index.ts`.

---

## Phase 2 — The site

### 2.1 What comes out

- **`#get` (the whole install section, `index.html:284–304`)** — the three-step Load-unpacked
  instructions and the "Download the extension" button. Replaced by the signup block.
- **Closing CTA (`index.html:308–312`)** — `Get the extension` / `Claim your handle` become
  `Join the waitlist` / `Become an alpha tester`.
- Note in passing: **`Claim your handle` currently links to `#handle`, which does not exist on
  the page.** That anchor has been dead for a while; it goes away with this change anyway.
- **`index.html:302`** — "A Chrome Web Store listing is on the way" should go or soften. It is a
  promise with a date attached in the reader's head.

### 2.2 What stays — deliberately

**Keep "Read the source" and "Rebuild & verify".** Removing them alongside a service pause would
read as retreat. Keep them prominent and add the self-host path:

> The hosted codec is paused while we run a closed alpha. The code is not.
> `git clone`, `cd codec`, `python3 server.py` — point the extension at `localhost:8080` and the
> whole thing works end to end, with no part of it touching us.

That is true today, costs nothing to say, and is the single most credible thing on the page.

### 2.3 The two CTAs

**Join the waitlist** — inline, one email field, one button. No modal. Friction here is pure loss.

**Become an alpha tester** — modal, in this order:

1. **The disclaimer, before the form.** Experimental. Expect bugs. Expect to reinstall by hand as
   we ship — there is no auto-update on a developer-mode extension. Expect the hosted codec to
   move or restart under you. Do not use it for anything that matters yet.
2. **Explicit agreement** — a checkbox, not a pre-ticked one. The text of what they agreed to and
   the timestamp get stored with the record.
3. **Telegram handle** (required) + **message** (optional, short).

### 2.4 Copy that does not contradict the product

There is a real tension and it will be noticed: the site says *no signup, no account, we hold
nothing* — and now there is a form. The resolution is to be explicit that these are different
things, on the form itself:

> This is a signup for **early access**, not an account. The product still has none. We are asking
> for a Telegram handle because it is a Telegram overlay and it is how we reach you to let you in.
> Nothing here touches your messages, your keys, or your handle on Lortnoc DM. We delete it once
> you are onboarded, or whenever you ask.

Handled this way it is a demonstration of the values. Handled silently it is the easiest possible
dunk on a privacy project.

---

## Phase 3 — Data plane

The site is static on Vercel, so serverless functions next to it is the least new infrastructure.

```
POST /api/waitlist   { email }                          → 204
POST /api/alpha      { telegram, message?, agreedAt }   → 204
GET  /api/admin/list (authenticated)                    → both lists
```

**Storage.** Vercel Postgres or KV. Do not put this in the relayer — its state is in-memory maps
that vanish on redeploy, and mixing a signup list into a service holding a funded key widens the
blast radius of both.

**Schema — collect the minimum that works.**

| waitlist | alpha |
|---|---|
| `email` | `telegram` (normalised, lowercase, leading `@` stripped) |
| `created_at` | `message` (cap ~500 chars) |
| `confirmed_at` (double opt-in) | `agreed_at` + the disclaimer version they agreed to |
| `source` (utm/referrer) | `created_at`, `source` |
| | `status` (new / invited / onboarded) |

**No IP logging.** §8 Layer 4 already claims gateway hygiene — "structural: the gateway *can't*
link; policy: it *doesn't* retain". Logging IPs on the signup form would contradict a published
claim. Rate-limit on a hashed, salted, short-TTL bucket instead.

**Abuse controls**, in order of value: a honeypot field (kills most bots for free) → per-window
rate limit → email format validation → duplicate collapse (upsert, never error — telling someone
"already registered" leaks membership of the list).

### 3.4 Single opt-in — decided, with the one mitigation worth keeping

Decision is single opt-in: collect the address, no confirmation step, no friction. That is a
reasonable call at this stage and I am not going to re-litigate it.

The one consequence that actually bites is **not** legal, it is operational: the first time you
mail a single-opt-in list, mistyped and malicious entries generate bounces and spam complaints,
and enough of those burn your sending domain — at which point the list is worthless because you
cannot reach it. Two things cost nothing and remove most of that risk:

- **Validate syntax + MX at submit time.** Rejects typos and junk domains instantly, no extra step
  for the user.
- **Send the first mail through a real ESP** (Resend, Postmark, SES) with a working unsubscribe
  link, not from a personal mailbox or a raw SMTP box.

Keep the retention line on the form regardless — consent is still the lawful basis in the EU, and
"we delete it whenever you ask" is both true and cheap.

**GDPR, briefly.** Email and Telegram handle are personal data, and you are operating in the EU.
You need a lawful basis (consent — hence the checkbox and double opt-in), a retention period
(state it: "deleted on onboarding or on request"), and a way to honour deletion. One
`DELETE /api/admin/entry` and a stated address is enough at this size.

---

## Phase 4 — Admin panel

Bear in mind what this list *is*: **people who publicly expressed interest in evading chat
surveillance, indexed by Telegram handle.** In an EU regulatory climate that produced Chat Control
in the first place, that is a sensitive dataset and should be treated as one.

- **Real auth.** Not an unguessable URL. Simplest sufficient: a single strong secret in an
  httpOnly cookie, set from an env var, with the whole `/admin` route behind it. Vercel password
  protection on the deployment is an acceptable stopgap. Do not ship a route whose only defence is
  that nobody has guessed the path.
- **What it needs to show, and nothing more:** both lists, sortable by date, a status toggle for
  alpha entries, CSV export, per-row delete.
- **Retention.** Purge onboarded alpha records. Do not accumulate a list you have stopped using.
- **Keep the admin UI out of the public bundle** — it is a separate route/deployment, so the
  static marketing site stays a static marketing site.

---

## Phase 5 — Repo and release surface

After a prominent mention, `github.com/forever8896/lortnoc_tahc` is where technical readers go
second. It should say the same thing the site does.

### 5.1 Taking the builds off the market — draft, do not delete

There are four public releases: `v0.7.0`, `v0.8.5`, `v0.8.6`, `v0.8.7`.

**Recommendation: convert them to drafts, not deletions.** `gh release edit <tag> --draft` removes
them from public view entirely — which is the outcome you want, "off the market" — while keeping
the artifacts, the checksums and the provenance attestations recoverable with one command. Deleting
destroys the SHA-256 chain that the "verify, don't trust" section was built on, and you will want
that back when the alpha opens. Drafting is the same public result and is reversible; there is no
upside to the irreversible version.

Two things must happen alongside it or the change undoes itself:

- **Neuter the release workflow.** `.github/workflows/release.yml` fires on `push: tags: ['v*']`,
  so the next tag republishes everything you just hid. Change the trigger to `workflow_dispatch`
  only until the alpha opens.
- **Fix `index.html:299`**, the one remaining link to `/releases/latest`. With releases drafted it
  404s. It is inside the install section being removed anyway, so this resolves itself — but
  verify it, because a 404 on the most prominent button is the worst possible artefact of this
  change.

Note that anyone who already downloaded 0.8.8 keeps it and it keeps working — until the codec
pauses, at which point they get the `/health` message from §1.3. That is the intended path.

### 5.2 Other repo surface

- **README banner** — alpha status, hosted codec paused, how to run your own codec, link to signup.
  The README is the first thing a technical visitor reads and it currently assumes the old funnel.
- **`SECURITY.md`** — worth adding now. The audience includes people who will go looking, and they
  need somewhere to report that is not a public issue.

---

---

## Phase 6 — Donation page

### 6.1 Decided: `lortnoctahc.eth` on mainnet, moved to a hardware wallet

Good choice, and better than a raw address for a reason worth naming: **a lookalike hex address is
trivial to produce, a lookalike ENS name is not.** It also solves cold storage and key separation
in one move. `0x61eE…1Bb8` — deployer, treasury, key in a fly container env — must never appear on
a donation page, and this avoids that entirely.

**Current mainnet state, checked 2026-07-29:**

| | |
|---|---|
| `lortnoctahc.eth` registrant | `0xe35D8aDd8A16A5d4CdA2E91F473a778950aC6b50` |
| `lortnoctahc.eth` addr record | `0xe35D8aDd8A16A5d4CdA2E91F473a778950aC6b50` |
| expires | **2027-07-25** (~1 year) |
| `lortnoc.eth` | **not registered on mainnet** — the §5.2 claim about it is Sepolia-scoped |

Good news up front: the mainnet name is already clear of the hot deploy key.

### 6.2 Moving the name does NOT move the donations

**This is the one that will bite.** Transferring the name to a hardware wallet and pointing
donations at it are two separate operations:

- **Ownership** (the registrant NFT, plus the manager/controller role) — who may change records.
- **The `addr` record** — where funds actually land when someone sends to `lortnoctahc.eth`.

Transfer the NFT and leave `addr` alone, and **every donation still goes to
`0xe35D…6b50`**, not to the hardware wallet. The name will look correctly moved in every UI while
quietly routing money to the old address.

This is the same failure as the 2026-07-27 Sepolia resolution bug, where `_claim` wrote
`eth.lortnoc.pubkey` and never wrote `addr`, so ten handles resolved a text record perfectly while
reporting `addr = 0x0`. Same class of mistake, second occurrence — and this time it is real money
rather than a rendering problem.

**Checklist, in order:**

1. Transfer the **registrant** to the hardware wallet.
2. Transfer the **manager / controller** too. If the old key keeps manager rights it can repoint
   `addr` at any time — that is a live redirect on your donation address, not a theoretical one.
3. **Set `addr` to the hardware wallet address.** Do not skip because the transfer "worked".
4. **Re-resolve the name and confirm `addr` equals the hardware wallet** before it goes on the
   site. Verify, don't trust — it is the project's own slogan.
5. Consider extending the registration past 2027-07-25 now. If the name lapses, the donation
   address becomes whoever renews it. For a published donation identity that is not routine
   housekeeping.

### 6.3 Publish the name and the resolved address together

Many wallets do not resolve ENS at all, and those that do resolve at send time — so a reader who
cannot verify what the name points to has to trust the page. Show both:

> `lortnoctahc.eth` → `0x…` *(resolve it yourself before sending)*

That also makes tampering detectable: if either value is altered anywhere, the pair stops matching.

### 6.2 Donations must buy nothing

This matters more than it sounds. A donate button sitting next to "become an alpha tester" will be
read as *donating gets me in*, or *donating gets me a handle*. Left implicit that becomes a refund
argument at best, and at worst starts to look like a pre-sale of access — which is a materially
different thing legally and reputationally.

State it plainly on the page:

> This buys nothing. It does not move you up the alpha list, it is not a pre-order, and it grants
> no handle, no account and no access. It funds the codec server and the people writing the code.
> If you want in, the alpha form above is free and always will be.

### 6.3 Impersonation is the operational risk

A project with sudden attention and a published wallet is the standard setup for address-spoofing:
fake replies, forked repos with a swapped address, DMs offering "early access".

- **One canonical address**, on `lortnoctahc.com`, mirrored verbatim in the repo README so the two
  can be cross-checked.
- State on the page: **"We will never DM you an address."**
- Keep the chain list short. One EVM address covers ETH and the L2s. Add Sui only if you actually
  want it — every extra address is another thing to verify and another thing to spoof.
- Show the address as text, copyable, plus a QR. Never as an image alone: an image cannot be
  verified against the repo by anyone scripting a check.

### 6.4 Keep records

Not legal advice and I am not the right source for it — but at any meaningful volume, donations
have tax and reporting implications that vary by where you are. Keep a record of what arrives from
day one, because reconstructing it later from chain data is miserable. If it becomes real money,
get actual advice.

---

## Risks I would flag before you commit to this

1. **Everyone who installed before the pause hits a wall.** Including people who arrived via the
   mention in the hours before the change. §1.3 mitigates this but does not eliminate it; the
   `/health` string is the only channel and it is one short line.

2. **Collecting Telegram handles for a privacy product is the obvious criticism.** It is
   defensible — it is a Telegram overlay, that is how you reach people — but only if you say so
   *on the form*, ask for nothing else, and state deletion. Silence here is what gets screenshotted.

3. **The repo is about to be read properly for the first time.** Mostly good news: the recent
   honesty pass on the sponsor pages and the test suite hold up. The exposure is operational
   (Phase 0), not reputational.

4. **A waitlist creates an obligation.** People who sign up expect to hear something. An empty list
   six weeks later is worse than no list. Decide now what the first email says and roughly when.

5. **Pausing is easy to reverse; a bad first impression is not.** The upside of this whole plan is
   that it is cheap to undo — one `fly secrets unset`. Treat that as licence to pause *early*
   rather than to delay deciding.

---

## Suggested order

| # | Step | Blocking? | Rough effort |
|---|---|---|---|
| 1 | Rotate treasury + registrar owner (0.1) | **Yes — before anything public** | 2 txs |
| 2 | Scrub operational detail from public docs (0.2) | Yes | minutes |
| 3 | `CODEC_PAUSED` mode + `/health` message (1.2, 1.3) | Yes | small |
| 4 | Site: remove install, add both CTAs (2.1–2.4) | Yes | medium |
| 5 | API endpoints + storage (3) | Yes | medium |
| 6 | Admin panel (4) | No — list can accrue first | medium |
| 7 | README / releases (5) | Soon after | small |
| 8 | 0.8.9 with a proper paused banner (1.4) | No | small |

Steps 3–5 should land together: a paused codec with no signup path is just a broken product.

## Open decisions for you

1. **Codec, or relayer, or both?** Recommendation above assumes codec only.
2. **Waitlist and alpha, or alpha only?** Two funnels means two follow-up obligations. Alpha-only
   is simpler and arguably better-targeted; the waitlist is the wider net.
3. **Cap the alpha?** A stated number ("first 50") creates urgency and bounds your support load.
4. **Who sends the first email, and when?** See risk 4.
5. **Keep `/releases/latest` public and downloadable, or mark 0.8.8 pre-release?**
