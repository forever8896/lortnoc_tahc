---
name: venice-studio
description: Create visual and audio media with the Venice AI API — generate an image, place a consistent character into new scenes, turn stills into video (image-to-video), record a voiceover (TTS), compose background music, and assemble it all into a finished video, ad, or storyboard. Use whenever the user wants to make an image, a character image, a storyboard, a video, an ad/trailer, a voiceover, or a music bed.
---

# Venice Studio

One key, the whole pipeline: **images · character compositing · image→video · voiceover · music · assembly.** Everything routes through two scripts in this skill's folder. Stdlib Python + ffmpeg, no install.

```
SKILL_DIR=~/.claude/skills/venice-studio
python "$SKILL_DIR/venice.py"   <image|edit|video|tts|music|models|voices|balance> ...
python "$SKILL_DIR/assemble.py" <kenburns|clip|concat|vo|loopfit|mix|caption|probe> ...
```

The key auto-resolves from `$VENICE_API_KEY` or a `VENICE_API_KEY=` line in a `.env` (cwd or any parent). Each Venice command prints the output file path; run `venice.py balance` to see USD left.

## When the user asks for…
- **an image** → `venice.py image --prompt "…" --out x.png` (default model `flux-2-pro`; try `nano-banana-pro`, `ideogram-v4`, `seedream-v4`).
- **a specific character in a scene / keep a character consistent** → start from a reference PNG and `venice.py edit --image ref.png --prompt "place this exact character …, keep its design identical" --out shot.png`. `nano-banana-pro-edit` is excellent at holding a character across shots — this is how you get the SAME character in every frame.
- **a voiceover** → `venice.py tts --text "…" --voice Brian --out vo.mp3` (run `venice.py voices` for the list; Brian/Bill/George/Chris are strong; **avoid kokoro — it sounds robotic**).
- **music** → `venice.py music --prompt "…" --duration 20 --instrumental --out bed.mp3`.
- **a video / ad / trailer / storyboard-to-video** → follow the workflow below.

## Workflow for a full video (image → motion → voice → music → cut)
1. **Brief.** Pin down: style/tone, length, the character(s), whether there's a voiceover (and voice), and music mood. Ask only what you can't reasonably choose.
2. **Storyboard.** Write the shot list — for each shot: the visual, any motion, the VO line, any on-screen text. Share it before spending.
3. **Stills (cheap, ~$0.04–0.20 each).** Generate every key frame: `image` for new scenes, `edit` (with a reference) for any shot featuring the character. Show them to the user before the expensive step.
4. **Motion (costs real money — ~$0.76 per 5s clip; confirm first).** For shots that should move: `venice.py video --image still.png --prompt "<the motion>" --duration 5s --out clip.mp4`. For static shots, the cold open, and **anything with a human face** (Venice gates face→video behind a consent attestation), skip generation and use a Ken Burns push-in instead: `assemble.py kenburns --image still.png --duration 6 --out clip.mp4 [--bw]`.
5. **Voiceover.** One `tts` call per line or per storyboard beat (separate files make timing easy).
6. **Music.** One or two `music` beds (e.g. an energetic bed + a soft bed for a tonal shift).
7. **Assemble:**
   - normalize each shot to a clip: `kenburns` (stills) or `clip` (trim/normalize a generated mp4),
   - `concat --inputs s1.mp4 s2.mp4 …` → one silent video,
   - `vo --inputs l1.mp3 l2.mp3 …` → one voice track (auto-gaps),
   - `loopfit` each music bed to length (with fades), then
   - `mix --video silent.mp4 --vo vo.mp3 --music bed.mp3 --out cut.mp4` (music auto-ducks under the voice),
   - `caption --in cut.mp4 --text "…" --start S --end E` for on-screen text/end cards.
8. **Review & iterate.** You can't hear audio or watch motion yourself — extract a frame (`ffmpeg -ss T -i v.mp4 -frames:v 1 f.png`) to spot-check visuals, then hand the file to the user and ask what to tune (voice, pacing, a reshot frame).

## Money & manners
- Images and TTS are cents; **video and music cost real money.** Before generating a batch of clips, state the rough total and get a go. Check `venice.py balance` first and after.
- Put working files in a dedicated folder (a project `media/` dir or the session scratchpad), not scattered in the repo.
- **Never wildcard-delete near your output** (`rm s*.mp4` once ate the final cut — its name started with `s`). Remove intermediates by explicit name.

## Catalog (as of 2026)
32 image · 100+ video (seedance, wan — `image-to-video` & `reference-to-video`) · 11 music (elevenlabs-music, lyria-3-pro, stable-audio-25) · 11 TTS voices. List any with `venice.py models --type <image|video|tts|music>`.

Worked example: the Starchild "PurposeMaxxing" teleshopping ad was built entirely this way (~$5 total) — see the `venice-media-ad-pipeline` memory for the concept and per-step costs.
```
