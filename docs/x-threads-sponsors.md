# sponsor threads — posts 2-5

your post 1 goes on top of each.

format: 2 = what the app and platform is · 3 = what tech and why we needed it
· 4 = how the integration worked · 5 = thanks

surfaces kept distinct throughout:
**Lortnoctahc plugin** = the browser extension inside Telegram
**Lortnoctahc DM** = our own messenger

every post is under 280. checked, not guessed — `node docs/check-threads.mjs`.

---

## ens — for Lortnoctahc DM

**2/**
Lortnoctahc DM is our own messenger.

fully private. nothing sitting on anyone else's platform.

you get there from the plugin, which hides your real messages inside Telegram.

the plugin is the on-ramp. DM is where you land.

both are in closed alpha. waitlist is open.

**3/**
every DM account is an @ens v2 subname.

why we needed that:

we sell accounts. that's the business.

but an account a company can delete isn't an asset.

it's a rental.

which is exactly what everyone is trying to escape.

**4/**
we run our own registry under lortnoctahc.eth. on sepolia, where v2 lives today.

every user gets their own resolver.

our gateway can write one record. reverted on everything else.

claims are relayed, so whoever paid and whoever owns the name are never the same address.

**5/**
thank you @ens 🙏

v2 made the registry pluggable.

that's the only reason we could issue names on a rule that isn't "this wallet paid"

which is the whole privacy story.

---

## 0G — for both surfaces

**2/**
two things we built:

Lortnoctahc plugin. encrypts your messages into small talk inside Telegram.

Lortnoctahc DM. our own fully private messenger.

0G is in both.

both in closed alpha right now.

**3/**
small talk only works if it sounds like small talk.

a sentence nobody would ever really send is a flag all by itself.

so something has to judge how human it reads.

but that judge sees text derived from your private message.

it can't be anywhere that keeps logs.

**4/**
we write every message a few ways, locally.

@0G sealed compute picks the one that reads most human.

the encoder never leaves your machine. hosted inference isn't deterministic, and determinism is what makes a message decodable.

0G chain settles DM payments.

**5/**
thank you @0G 🙏

you told us straight we couldn't deploy our own model into the TEE yet.

that answer gave us a better architecture than the easy path would have.

we don't verify the attestation per response yet. so we say architecture, not proof.

---

## sui / walrus / seal — for Lortnoctahc DM

**2/**
Lortnoctahc DM is our own messenger.

fully private. nothing left sitting on anyone's platform.

you arrive from the plugin, which hides your real messages inside Telegram.

the plugin is the hook. DM is the destination.

closed alpha, waitlist open.

**3/**
your DM conversations have to live somewhere.

if that somewhere is us, we've made ourselves the easiest thing in the whole system to subpoena.

so we needed two things at once:

storage that can't read what it holds.

and an access rule we can't quietly change.

**4/**
@sui seal encrypts every message.

walrus scatters it as fragments no single node can read.

a sui object tracks the current one.

who may decrypt is seal_approve. a move function the key servers dry-run against live chain state.

not a check hidden in our backend.

**5/**
thank you @sui, walrus and seal 🙏

one key server today, not a committee. we'd rather say that than round up.

making the policy arbitrary move instead of a fixed allowlist is what let us design toward a vault gated on a zk nullifier.

---

## what changed, and why

Kirsten's structure and voice kept throughout. three claims were factually
wrong and would not have survived being checked by the people we're tagging.

- **ens 4/** said the registry sits under `lortnoc.eth`. it's
  **`lortnoctahc.eth`** — `lortnoc.eth` is the deliberately-unused one, and it
  isn't registered on mainnet at all. added "on sepolia, where v2 lives today",
  because "we run our own registry" reads as mainnet otherwise and there is
  nothing there to find.
- **sui 4/** said messages are **threshold encrypted**. we run one key server
  at threshold 1 of 2. CLAUDE.md §6.4 says it outright: *say "Seal with an
  on-chain policy", not "threshold encryption across a committee"*. tagging
  Mysten with a claim their own docs contradict is the worst possible audience
  for it. the honest version moved to 5/ as a strength — naming the limit is
  more credible than rounding up, and it's the same move the site makes.
- **0G 4/** said sealed compute **"keeps nothing"**. we don't capture or verify
  a TEE attestation per response, so that isn't ours to assert. dropped, and 5/
  now carries "architecture, not proof" — which matches the 0G page word for
  word, so a reader clicking through finds the same sentence rather than a
  hedge that contradicts the thread that sent them.

**funnel**: every thread sold "install it". installs are closed and the
releases are coming down, so each 2/ now says closed alpha with the waitlist
open. sending people from a thread to a page that tells them a different story
is the one thing worse than not posting.

## notes

- **no quilt claim anywhere** — kept. the sui page no longer leads on it either:
  it now states we ship one blob per message and why, with the measurement.
- handles left in your short forms (`@ens`, `@sui`, `@0G`). worth confirming
  they're the live accounts, that's what triggers the reposts.
- 0G compute runs on **testnet** via the broker sidecar; 0G **chain** is
  mainnet. no post claims otherwise, but don't add one that does.
