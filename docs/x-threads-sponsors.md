# sponsor threads — posts 2-5

your post 1 goes on top of each. these follow the format:
2 = what the app/platform is · 3 = what tech + why we needed it ·
4 = how the integration worked · 5 = thanks

surface split used throughout:
- **lortnoctahc plugin** = browser extension, hides real messages inside telegram
- **lortnoctahc dm** = our own fully private messenger

---

## ens — for lortnoctahc DM

**2/**
lortnoctahc dm is our own messenger. fully private, no platform in the middle.

you get there from the plugin — a browser extension that hides your real messages inside telegram.

the plugin is the on-ramp. dm is where you land.

**3/**
every dm account is an @ens v2 sub-name.

we sell those accounts. that only works if the account is genuinely yours — one a company can delete is a rental, not an asset.

v1 couldn't do it. control there is all-or-nothing: whoever can write, can write everything.

**4/**
we run our own registry under lortnoc.eth, built on v2's UserRegistry.

every user gets their own resolver. our gateway can write exactly one text record and is reverted on every other. every time.

claims are relayed, so the payer and the owner are never the same address.

**5/**
thank you @ens 🙏

v2 making the registry pluggable is the only reason any of this was expressible. we got to issue names on a rule that isn't "this wallet paid" — and that's the whole privacy story.

---

## 0G — for BOTH surfaces

**2/**
two surfaces:

lortnoctahc plugin — browser extension, hides your real messages inside telegram

lortnoctahc dm — our own fully private messenger

0G shows up in both.

**3/**
in the plugin: cover text only works if it reads like a person wrote it.

a sentence nobody would ever really send is itself a flag.

so something has to judge how natural it sounds — and that judge sees text derived from your private message. it can't be anywhere that logs.

**4/**
we write each message several ways locally. @0G sealed compute scores which reads most human, and keeps nothing.

the encoder stays local — hosted inference isn't deterministic, and determinism is what makes a message decodable.

0G chain settles dm payments behind a nullifier.

**5/**
thank you @0G 🙏

you told us straight that deploying our own model into the tee wasn't supported yet. that answer forced a cleaner split than the easy path would have — determinism where reversibility needs it, sealed compute where privacy does.

---

## sui / walrus / seal — for lortnoctahc DM

**2/**
lortnoctahc dm is our own messenger — fully private, nothing left sitting on anyone's platform.

you arrive from the plugin, which hides your real messages inside telegram.

the plugin is the hook. dm is the destination.

**3/**
dm conversations have to live somewhere.

if that somewhere is ours, we've made ourselves the easiest thing in the system to subpoena.

so we needed two things together: storage that can't read what it holds, and an access rule we can't quietly change.

**4/**
messages get threshold-encrypted by @sui seal, then scatter across walrus as fragments no single node can read.

a sui object tracks the current blob.

who may decrypt is seal_approve — a move function running on-chain, not a check buried in our backend.

**5/**
thank you @sui + walrus + seal 🙏

making the access policy arbitrary move instead of a fixed allowlist is what let us design toward a vault gated on a zk nullifier. the ceiling being that high changed what we tried.

---

## notes

- **quilt is NOT claimed** anywhere here — your own commit says it was measured
  and skipped. the earlier site copy still leans on it.
- handles kept in your short forms (`@ens`, `@sui`, `@0G`). worth confirming
  they're the live accounts before posting — that's what triggers reposts.
