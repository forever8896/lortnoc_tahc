# Landing v2 — storyboard

The old page is scrapped, films included. Photoreal. Two scroll-scrubbed films with a text interlude between them.

## Copy

**Hero** (over K1)
> **Private conversations in public places.**
> Post to everyone. Speak to your people. Lortnoc Tahc lets you create a private commons within the public commons.

**1 · The square is watched** (K2–K4)
> Chat Control. The Online Safety Act. The list grows every year. *(verify list before ship)*
> Everything you say in public is read, scraped and profiled.
> **Then it's used to write back.** Campaigns built from your own words, aimed at what you think.
> Surveillance reads. Manipulation writes. It's one machine.

**2 · Leaving means losing everything** (K5–K6)
> Private chats are safe, and invisible. No discovery. No reach. No one new.
> And going dark marks you as someone with something to hide.
> So most people stay, and learn to watch what they say.

**3 · Hide in plain sight** (K7–K8)
> What if the conversation stayed right here, and only looked like something else?
> Natural Language Encryption turns your words into ordinary posts. Outsiders see small talk. Your people see the real conversation.

**Interlude (no film):** a Reddit-style thread, the same post in two views: what outsiders see and what your people see.

**4 · You decide who gets in** (K9–K10, plus a gate-builder UI panel)
> Every hidden conversation has a gate. **Build your own from any rule that can be proven**, or start with two that work out of the box:
> **ENS v2 subnames.** Hold a name under `yourdao.eth`? You're already inside.
> **World ID.** A verified citizen of Denmark? Join your country's conversation, free of outside interference. A zero-knowledge proof: it shows you qualify, never who you are.
> Whistleblowers and journalists get reach without exposure.

**5 · A hidden internet, inside the internet** (K11–K12)
> Reddit. X. Telegram. Any platform, any thread.
> A private commons within the public commons. You're not alone in here.
> → CTA

## Look

- One location: a large European cobblestone square on an overcast day. Flat grey light, muted palette.
- CCTV cameras on lamp posts and building corners, visible in most frames.
- **Dark figures:** plain dark coats, faces never clearly visible (backs, shadow, hats). Ordinary but wrong.
- **Mirror boxes:** freestanding pavilions with one-way-glass walls. Seen from outside they show a grey, ordinary scene. Inside they're warm light with the teal accent `#12C4BE` in the details.
- Characters are shot mid or wide and mostly in profile or from behind. Emotion comes from body language, not close-ups (realism holds up better, and it avoids face→video gating).

## Cast

Created first as reference images; every scene shot is edited from them so the same people carry through.
Every group mixes women and men of different heights, builds, ages and ethnicities.

- **The bench group** (5): the people who get surrounded in part 1.
- **The young group** (6, 20s): the fountain steps in part 2, then the same six inside the mirror box in parts 3–4.
- **The friend** (1): the person welcomed through the door.
- **The dark figures:** plain black coats, faces in shadow, never clearly seen.

## Keyframes

Each transition is generated with its start and end frames fixed (`flf.py`), so each segment begins on the previous one's end frame and there are no cuts.
One simple move per segment. Segments are retimed to about 2.5–3s when assembling.

### Film A — outside
| # | Frame | Part |
|---|---|---|
| A1 | Wide establishing shot. The overcast square, groups in muted everyday colours, CCTV cameras large on the lamp posts and corners. | Hero |
| A2 | Push-in toward the crowd, a CCTV camera sharp in the foreground. | 1 |
| A3 | Same frame: several ordinary people have **turned dark**. Black coats, faces in shadow. | 1 |
| A4 | The dark figures walk from different directions toward the bench group. | 1 |
| A5 | The bench group is surrounded and silent, looking down. | 1 |
| A6 | **The "write":** dark figures peel off and lean into *other* groups, talking. | 1 |
| A7 | Those groups nod along; one person types what they heard into a phone. | 1 |
| A8 | Pan across the square to the young group on the fountain steps, mid-laugh. | 2 |
| A9 | They turn toward the commotion, worried. | 2 |
| A10 | They look at each other, shrug and keep talking, still tense. | 2 |
| A11 | One of them turns their head to look right (over the shoulder). | 2 |
| A12 | Their point of view: a mirror pavilion across the square. | 3 |
| A13 | Eye level at the pavilion: **true mirror walls** reflecting the grey square and the passing dark figures. Behind the reflection, a dim grey decoy of the group chatting. | 3 |
| A14 | The crane rises up the mirror wall toward the open top. | 3 |
| A15 | Overhead looking in: the same six young people, warm light, different clothes, animated. | 3 |

### Film B — inside and out
| # | Frame | Part |
|---|---|---|
| B1 | The camera descends inside to eye level: warm light, mirrored walls on every side. | 4 |
| B2 | One of them turns toward a door set into the mirror wall. | 4 |
| B3 | The door is open and the friend is welcomed in from the grey daylight. | 4 |
| B4 | The camera passes through the door out into the square. | 5 |
| B5 | The crane rises above the rooftops. | 5 |
| B6 | High aerial view: the square dotted with mirror pavilions glowing warm inside, dark figures walking between them, unaware. | 5 |

## Budget (Venice)

- Stills: 4 cast references + 21 keyframes, about 2 variants each → about $5.
- Motion: 20 segments of 5s → about $13 per clean pass, **$30–40 with retakes**. Get a quote before each batch.
- Scrub encodes: Film A about 10 MB, Film B about 6 MB, plus separate mobile clips for each part.
