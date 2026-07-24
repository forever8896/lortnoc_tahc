# Landing page prompt — paste into Claude

---

Build me a single-page, scroll-driven manifesto landing page for a privacy product called **Lortnoc Tahc**. Self-contained HTML, inline CSS and JS, no external requests, no frameworks, no CDN.

This is not a product page. It is a **declaration of war on a surveillance law**, and it has to hit like one. Big type, hard stops, total confidence. Someone should scroll it once and be unable to stop saying the name.

## The story

The EU passed **Chat Control** — a law that lets platforms and governments read every message you send. Encryption doesn't save you, because the scanning happens *before* your message is encrypted.

Lortnoc Tahc is a browser extension that hides your real messages *inside* the platforms doing the scanning. You type what you mean. The platform stores innocent small talk. The person you're talking to sees the real thing. Nobody had to give us permission.

That's the wedge. The endgame is **Lortnoc DM** — our own private protocol — and every extension user is one click from claiming their place on it.

The name is **"Chat Control" spelled backwards**: `lortnoC tahC` → **Lortnoc Tahc**. Spell it exactly that way, every time. The reversal is the whole hook and people will check it.

## Voice

Cold fury, not startup cheer. Short sentences. Hard periods. Second person — this is happening to *you*.

The threat sections read like a court document. The product sections read like someone leaning across a table telling you the way out. That whiplash between the two registers is the entire emotional engine of the page. Build to it.

No emoji. No exclamation marks. No "revolutionary," "seamless," "leverage," "empower," "game-changing." Confidence comes from restraint and from the size of the claim, never from adjectives.

Never call this an AI company. "Natural Language Encryption" is the phrase. Repeat it.

## Design system

- **Type:** Questrial for the wordmark, Jost (300–700) everywhere else, `system-ui` fallback. Display type should be enormous — `clamp(48px, 9vw, 160px)` on the hero lines, tight leading (0.95–1.05), slight negative tracking. Body stays small and calm by contrast: 17–19px, line-height 1.75, max-width 620px.
- **Palette:** black `#08080A`. Bone `#EDEAE4`. One signal color — surveillance green `#4ADE80` — used on under 5% of the page so it detonates when it appears. Muted text `rgba(237,234,228,0.5)`. Hairline rules `rgba(237,234,228,0.12)`.
- **Space is the flex.** Enormous black gaps between beats — 160px+. A landing page that isn't afraid of empty space reads as expensive.
- **Motion:** `opacity` and `transform` only. Every animated section needs a static, fully readable `prefers-reduced-motion` fallback.

## Structure — eight beats

### 0. Cold open
Full viewport. Black. No nav, no logo, no button.

Small mono eyebrow, signal green, letter-spaced wide:
> `[DATE] — EUROPEAN UNION`

Then, enormous:
> **They made it legal to read your messages.**

Beneath, smaller, muted:
> Every platform. Every message. Scanned before it's ever encrypted. It's called Chat Control, and it is already law.

A thin scroll cue at the bottom. Nothing else. Let it sit in silence.

### 1. The threat
Three statements, each fading up on its own as you scroll, each alone on the screen. Flat. Factual. No adjectives:

> Encryption happens after the scan.
> So encryption doesn't matter.
> They read it first.

Then, after a long black gap, in the signal color:
> They wrote the law assuming you'd accept it.

### 2. The reversal — SIGNATURE MOMENT
Pinned full-viewport section inside a ~300vh track (`position: sticky; top: 0; height: 100vh`).

**CHAT CONTROL** sits centered in the largest type on the page. As the user scrolls, the letters **reverse one at a time, right to left**, until they read **LORTNOC TAHC**. It's driven entirely by scroll progress — scrolling back up un-reverses it. The user is scrubbing the transformation with their own hand.

Implementation: one `<span>` per character, map scroll progress across the character count, flip each span's content as its threshold passes. Add a fast blur-and-flicker on each character at the instant it flips. Ease the timing so the final letters land together instead of trailing off.

When it resolves, fade in beneath it, quiet and certain:
> **That's Chat Control spelled backwards.**

And under that, smaller:
> We built the opposite of the law.

This is the best moment on the page. Everything before it is setup and everything after it is payoff. Make it feel inevitable.

### 3. The trick — SIGNATURE MOMENT
Show it. Don't explain it.

Three panes, labeled in small mono caps: `WHAT YOU TYPE` / `WHAT THEY STORE` / `WHAT THEY READ`

- **Left:** "Hey, I'm gonna send you some crypto for our business deal"
- **Middle:** "Hey let's grab coffee today. The sun is out."
- **Right:** "Hey, I'm gonna send you some crypto for our business deal"

As it scrolls into view, animate the middle pane *transforming* out of the left pane's text — character scramble or word-by-word replacement that settles into the cover text. Then the right pane resolves back to the original. The middle pane should feel watched: a slow scan line, the signal color pulsing at its border.

Beneath:
> **Natural Language Encryption.**
> Your message becomes small talk. Small talk is all they get. The person you're talking to sees exactly what you wrote.

Then, hard:
> They're not blocked. They're not hacked. They're just reading the wrong conversation.

### 4. The line
One idea. As big as the page allows. Alone.

> **Encrypted messaging on unencrypted platforms.**

Below, small and flat:
> It runs inside Telegram as a browser extension. No new app. No bot. No account access. No permission asked, because none was required. It reads and writes the page you already had open.

### 5. The trojan horse
Two states, crossfading or side by side:

> Today your messages hide inside their platform.
> Tomorrow you don't need their platform.

Then:
> Every person who installs the extension can claim a handle on **Lortnoc DM** — our own private protocol, where there is nothing to scan, nothing to subpoena, and nobody to ask.
>
> The extension is how you get out. Lortnoc DM is where you land.

Frame it as an escape route, never as an upsell.

### 6. The stack
Three blocks. Each is a *capability*, not a logo. Headline in the signal color, two lines of body.

- **Your account is a name you own.**
  Every Lortnoc DM account is an ENS subdomain you claim and hold. It's your identity, your inbox, and how you get paid — and it belongs to you, not to us.

- **Your membership can't be traced to you.**
  Access is proven with a zero-knowledge proof. We can verify that you paid without ever learning which handle is yours. Unlinkable to your payment — not by us, not by anyone.

- **Your messages can't be deleted.**
  Every encrypted message lives in decentralized storage. Uncensorable, undeletable, and yours to walk away with whenever you want.

Keep the second block's wording exactly as written.

### 7. The close
Full viewport. Wordmark in Questrial, huge, centered.

> **Solving a real problem. With a real solution. And a real business model.**

Primary CTA, signal green, unmissable: **Get the extension**
Secondary, quiet, underlined: **Claim your handle**

Final line, small, muted, centered above the footer:
> *Lortnoc Tahc. That's Chat Control spelled backwards.*

## Interaction requirements

- `IntersectionObserver` + scroll-progress math only. No scroll libraries.
- Beat 2 must be genuinely pinned and scroll-scrubbed on desktop.
- Write scroll progress to a variable; apply it inside one `requestAnimationFrame` loop. Never write styles from the scroll handler directly.
- On touch and narrow viewports, swap beat 2's scrub for an in-view triggered animation. Do not scrub on touch.
- Fully readable, correctly ordered, and complete with JS disabled and under `prefers-reduced-motion`.
- Responsive at every width. No horizontal page scroll, ever.

## Do not

- No stock photography, decorative gradients, glassmorphism, or floating 3D shapes.
- No testimonials, pricing table, FAQ, team grid, or fake press logos.
- Never more than three sentences of body copy in one beat.
- Do not soften the copy. Do not add hedging words. Do not make it friendly.

Build the entire page. Beats 2 and 3 are the reason it exists — make them exceptional.
