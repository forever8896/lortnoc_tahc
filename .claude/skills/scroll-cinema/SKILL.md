---
name: scroll-cinema
description: Build scroll-driven cinematic sections — pinned full-viewport video scrollytelling where the scrollbar scrubs a continuous film, with graceful mobile/reduced-motion tiers; plus the production pipeline for making the film itself (frame-chained AI transitions between real photos via end-frame conditioning, ffmpeg assembly, all-intra encoding). Use when the user wants "scroll-locked" video sections, Apple-style scroll scrubbing, a process film for a landing page, seamless transitions between scenes/photos, or asks to animate real product/process photography into a scrolling experience.
---

# Scroll Cinema

Two crafts in one: (A) the **frontend pattern** for scroll-driven film sections, and (B) the **film production pipeline** that makes a continuous, seamless film out of stills, real photos, and AI clips. Built and battle-tested on a production storefront; the pitfalls below were all hit for real.

## A. The frontend pattern (capability-tiered, non-negotiable)

One section, three renderings, chosen by capability — this is the difference between "trend site" and "janky site":

| Tier | Who | What |
|---|---|---|
| **Scrub** | fine pointer + viewport ≥900px | ONE continuous film; scroll progress drives `currentTime` via a rAF loop with easing. The scrollbar IS the playhead; scrolling up plays the film backward. |
| **Chapters** | touch / small screens | The film's acts as separate small looping mp4s, crossfaded by scroll-driven `opacity` only. NEVER scrub on touch — `currentTime`-while-native-scroll is the documented jank path on Android. |
| **Static** | `prefers-reduced-motion` OR `navigator.connection.saveData`/2g | Poster images + text, normal document flow. |

Mechanics (see `reference-component.jsx` for a complete React/framer-motion implementation):

- **Track & stage:** a tall track (`height: ~25-35vh per film-second`) with a `position: sticky; top: 0; height: 100vh` stage inside. `useScroll({ target, offset: ['start start','end end'] })` → progress 0..1.
- **Scrub loop:** scroll handler writes progress to a **ref** (never state); a single rAF loop eases the playhead: `smooth += (target*duration - smooth) * 0.14; if (|video.currentTime - smooth| > 0.02) video.currentTime = smooth`. The easing converts wheel steps into cinematic inertia.
- **Text overlays** are `opacity`/`transform`-only (GPU-cheap), timed to the film's act boundaries in seconds, fading OUT during camera-travel segments so moves play clean.
- **Perf gating (mandatory):** video `src` attaches only when the section is within ~1.5 viewports (IntersectionObserver + `rootMargin: '150% 0px'`), `preload="none"` until then, posters meanwhile. A film with `preload="auto"` at mount WILL download megabytes on initial page load — measured mistake. In chapter mode, only the active chapter's video plays; pause the rest.
- Video element: `muted playsInline` always; never call `.play()` in scrub mode (seek only).

## B. Producing the film

The goal is ONE continuous take — no dissolves. Dissolves between unrelated clips read as a slideshow; the user will notice and say so.

### Scene strategy (learned the hard way)
1. **Real photos beat generated scenes.** Ground every act in the user's real assets when they exist (product shots, process photos, phone footage frames).
2. **AI-generated wide shots of technical apparatus WILL have wrong anatomy** (tubes to nowhere, impossible plumbing). Two working fixes: (a) **stay close** — macro framing where each frame only needs local truth; (b) **relight, don't invent** — use an image-EDIT model with the real photo as reference: "keep this exact [object] and its geometry perfectly identical; re-photograph it in [lighting/scene]". Geometry stays real; only light is invented. This preserved a printed "50/42" joint marking and a product label perfectly.
3. **Never image-to-video a still that carries text/labels** — i2v drifts text (a Jupiter glyph became "24"). For label-bearing stills use Ken Burns instead: forward zoompan + reversed copy concatenated = seamless "breathing" palindrome loop, zero drift, zero cost.
4. Grade real daylight photos into the film's palette with ImageMagick/ffmpeg (this is color work, not AI). **Pitfall:** ImageMagick `-vignette` defaults to WHITE — always `-background black -vignette ...`.

### Seamless transitions: end-frame conditioning (the core trick)
Venice's video API accepts **`end_image_url`** alongside `image_url` (verified; not exposed by most wrappers — use `flf.py` in this skill's folder). With Kling models this generates a camera move that starts EXACTLY on frame A and lands EXACTLY on frame B:

```
python3 flf.py START.png END.png "Continuous smooth slow camera move, no cuts: the camera glides from [A] across [scene], coming to rest on [B]. Photorealistic, gentle motion, cinematic." out.mp4
```

Chain rule: every segment must start on the previous segment's literal last frame. Extract it exactly:
`ffmpeg -sseof -0.05 -i seg.mp4 -frames:v 1 -q:v 2 chain.png` (note: `-sseof` BEFORE `-i`).
For FLF-conditioned segments the shared keyframe itself is the chain point — segment N ends on keyframe K, segment N+1 starts from K.

This also lets generated camera travels **land on real photographs** — the transition's end frame IS the real photo. That's how you fuse generated motion with authentic material.

### Assembly & encoding (see `ffmpeg-recipes.md` for full commands)
- Normalize every segment: same WxH (e.g. 1152x648), `fps=24`, `setsar=1`, then `concat` filter — no xfade anywhere.
- **Scrub master must be all-intra:** `-c:v libx264 -crf 28 -x264-params keyint=1:scenecut=0 -movflags +faststart`. Every frame a keyframe = every scroll position seeks instantly. Cost: ~0.3MB/s at 1152x648 — that's the price of random access; budget ~8-12MB for 30s.
- Mobile chapter loops: normal encode (crf 26), loop via tail-crossfade — `[0]trim=end=D-1[v0];[0]trim=start=D-1[v1];[v1][v0]xfade=fade:1:0` — or palindrome for Ken Burns acts.
- **VERIFY EVERY JOIN:** extract frames at boundary±0.1s, montage them side by side, and look. `for t in 4.9 5.1 ...; do ffmpeg -ss $t -i film.mp4 -frames:v 1 j$t.png; done; montage ...`. Joins that aren't pixel-matched read as cuts.

### Budget discipline (Venice, as of 2026)
Stills/edits are cents; video costs real money (kling-o3-standard 5s ≈ $0.61 — quote first via `/video/quote`). Check `balance` before batches; state totals before generating. Generate stills → show/judge → animate only winners. A blind API probe with junk input still queues a real paid job — don't.

## Order of work (whole feature)
1. Read the brand: palette, register, existing assets. Collect the user's REAL photos/footage first.
2. Storyboard acts + transitions; get the user's eyes on keyframes BEFORE animating (stills are cheap, motion isn't — and taste vetoes happen at every step).
3. Produce keyframes (real > relit-real > generated-closeup), then FLF transitions, then assemble + verify joins.
4. Build the component (copy `reference-component.jsx` as the starting point), retime `FILM_TEXT_SEC`/`FILM_BOUNDS` to the actual cut.
5. Perf pass: deferred src, data-saver tier, measure payloads per device class before declaring done.
