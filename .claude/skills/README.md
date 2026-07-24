# Project skills — landing-page animation

These are Claude Code skills, auto-loaded when you open this repo in Claude Code. Two are set up for
building the scroll-driven landing page with AI-generated assets:

- **`scroll-cinema`** — build scroll-locked cinematic sections (pinned full-viewport video that the
  scrollbar scrubs), plus the pipeline for producing the film itself (frame-chained transitions, ffmpeg
  assembly). Invoke with `/scroll-cinema` or just describe the scroll section you want.
- **`venice-studio`** — generate images, characters, image-to-video, voiceover, and music via the
  **Venice AI API**, and assemble them. Invoke with `/venice-studio`.

## Setup (once)

```bash
cp .env.example .env      # then paste the Venice key Kilian sends you
```

`venice-studio` reads `VENICE_API_KEY` from the environment / `.env`. The real `.env` is gitignored —
never commit it. Ask Kilian for the key over a secure channel.

## Typical flow

1. `/venice-studio` — generate the frames/clips/voiceover for the section.
2. `/scroll-cinema` — chain them into the scroll-scrubbed film and wire the pinned scroll component.
