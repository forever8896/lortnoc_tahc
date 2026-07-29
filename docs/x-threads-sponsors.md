# sponsor threads — posts 2-5

your post 1 goes on top of each.

format: 2 = what the app and platform is · 3 = what tech and why we needed it
· 4 = how the integration worked · 5 = thanks

surfaces kept distinct throughout:
**Lortnoctahc plugin** = the browser extension inside Telegram
**Lortnoctahc DM** = our own messenger

---

## ens — for Lortnoctahc DM

**2/**
Lortnoctahc DM is our own messenger.

fully private. nothing sitting on anyone else's platform.

you get there from the plugin.

install it, keep using Telegram, bring your friends over when you're ready.

the plugin is the on-ramp. DM is where you land.

**3/**
every DM account is an @ens v2 subname.

why we needed that:

we sell accounts. that's the business.

but an account a company can delete isn't an asset.

it's a rental.

which is exactly what everyone is trying to escape.

**4/**
we run our own registry under lortnoc.eth.

every user gets their own resolver.

our gateway can write one record. it gets reverted on everything else.

and claims are relayed, so whoever paid and whoever owns the name are never the same address.

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

**3/**
small talk only works if it sounds like small talk.

a sentence nobody would ever really send is a flag all by itself.

so something has to judge how human it reads.

but that judge sees text derived from your private message.

it can't be anywhere that keeps logs.

**4/**
we write every message a few ways, locally.

@0G sealed compute picks the one that reads most human. keeps nothing.

the encoder stays on your machine.

hosted inference isn't deterministic, and determinism is what makes a message decodable.

0G chain settles DM payments.

**5/**
thank you @0G 🙏

you told us straight that we couldn't deploy our own model into the TEE yet.

that answer gave us a better architecture than the easy path would have.

determinism where it's needed. sealed compute where privacy is.

---

## sui / walrus / seal — for Lortnoctahc DM

**2/**
Lortnoctahc DM is our own messenger.

fully private. nothing left sitting on anyone's platform.

you arrive from the plugin, which hides your real messages inside Telegram.

the plugin is the hook. DM is the destination.

**3/**
your DM conversations have to live somewhere.

if that somewhere is us, we've made ourselves the easiest thing in the whole system to subpoena.

so we needed two things at once:

storage that can't read what it holds.

and an access rule we can't quietly change.

**4/**
messages get threshold encrypted by @sui seal.

then scatter across walrus as fragments no single node can read.

a sui object tracks the current one.

and who's allowed to decrypt is seal_approve. a move function running on chain.

not a check hidden in our backend.

**5/**
thank you @sui, walrus and seal 🙏

making the access policy arbitrary move instead of a fixed allowlist

is what let us design toward a vault gated on a zk nullifier.

the ceiling being that high changed what we even tried.

---

## notes

- **no quilt claim anywhere** — your own commit says it was measured and
  skipped. the sui page on the site still leads on it.
- handles left in your short forms (`@ens`, `@sui`, `@0G`). worth confirming
  they're the live accounts, that's what triggers the reposts.
