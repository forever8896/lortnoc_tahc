#!/usr/bin/env python3
"""Venice AI media studio — one CLI for image / character-edit / image-to-video /
voiceover (TTS) / music. Stdlib only (urllib), so it runs anywhere.

Key resolution order: --key  ->  $VENICE_API_KEY / $VENICE_INFERENCE_KEY  ->
a VENICE_API_KEY|VENICE_INFERENCE_KEY|VENICE_KEY line in a .env found in the cwd
or any parent dir.

Examples
  python venice.py image  --prompt "a neon city at dusk" --out city.png
  python venice.py edit   --image hero.png --prompt "put this character on a beach" --out beach.png
  python venice.py video  --image beach.png --prompt "gentle waves, hair blowing" --duration 5s --out clip.mp4
  python venice.py tts    --text "Welcome to the future." --voice Brian --out vo.mp3
  python venice.py music  --prompt "warm cinematic piano, hopeful" --duration 20 --out bed.mp3
  python venice.py models --type video        # list model ids of a type
  python venice.py voices --model tts-elevenlabs-turbo-v2-5
  python venice.py balance
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error

BASE = "https://api.venice.ai/api/v1"
KEY_VARS = ("VENICE_API_KEY", "VENICE_INFERENCE_KEY", "VENICE_KEY")

# sensible defaults per task (override with --model)
DEFAULTS = {
    "image": "flux-2-pro",                       # also: nano-banana-pro, gpt-image-2, ideogram-v4, seedream-v4
    "edit":  "nano-banana-pro-edit",             # best at keeping a character consistent across scenes
    "video": "seedance-2-0-fast-image-to-video", # quality: seedance-2-0-image-to-video / wan-2-7-image-to-video
    "tts":   "tts-elevenlabs-turbo-v2-5",        # natural; voices: Brian, Bill, George, Chris, Alice, Aria...
    "music": "elevenlabs-music",                 # also: lyria-3-pro, stable-audio-25, minimax-music-v26
}

def resolve_key(cli_key):
    if cli_key:
        return cli_key
    for v in KEY_VARS:
        if os.environ.get(v):
            return os.environ[v]
    d = os.getcwd()
    for _ in range(8):
        p = os.path.join(d, ".env")
        if os.path.isfile(p):
            for line in open(p, encoding="utf-8", errors="ignore"):
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, val = line.partition("=")
                if k.strip() in KEY_VARS:
                    return val.strip().strip('"').strip("'")
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    sys.exit("No Venice key found. Set $VENICE_API_KEY or pass --key, or add VENICE_API_KEY=... to a .env.")

def _hdr(key):
    return {"Authorization": "Bearer " + key, "Content-Type": "application/json"}

def post(path, payload, key, timeout=300):
    r = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers=_hdr(key))
    return urllib.request.urlopen(r, timeout=timeout)

def get(path, key, timeout=60):
    r = urllib.request.Request(BASE + path, headers=_hdr(key))
    return urllib.request.urlopen(r, timeout=timeout)

def is_media(b):
    return (b[:4] == b"\x89PNG" or b[:3] == b"\xff\xd8\xff" or b[4:8] == b"ftyp"
            or b[:3] == b"ID3" or b[:2] == b"\xff\xfb" or b[:4] == b"RIFF" or b[:4] == b"OggS")

def save_bytes_or_json(body, out):
    """Venice image/audio endpoints return RAW media bytes; some return JSON with b64/url."""
    if is_media(body):
        open(out, "wb").write(body); return
    try:
        d = json.loads(body)
    except Exception:
        open(out, "wb").write(body); return
    b = None
    if isinstance(d, dict):
        b = (d.get("images") or [None])[0] or (d.get("data") or [{}])[0].get("b64_json")
        url = d.get("download_url") or (d.get("data") or [{}])[0].get("url") if not b else None
        if not b and url:
            open(out, "wb").write(urllib.request.urlopen(url, timeout=180).read()); return
    if isinstance(b, str):
        if b.startswith("data:"):
            b = b.split(",", 1)[1]
        open(out, "wb").write(base64.b64decode(b)); return
    raise SystemExit("Unexpected response: " + json.dumps(d)[:400])

def data_url(path):
    ext = "png" if path.lower().endswith(".png") else "jpeg"
    return f"data:image/{ext};base64," + base64.b64encode(open(path, "rb").read()).decode()

def poll_queue(retrieve_path, qid, model, key, poll, max_polls, out):
    print(f"  queued {qid} — polling…", file=sys.stderr)
    for _ in range(max_polls):
        time.sleep(poll)
        try:
            r = post(retrieve_path, {"queue_id": qid, "model": model}, key)
            body = r.read()
            if is_media(body) or r.headers.get("Content-Type", "").startswith(("video", "audio")):
                open(out, "wb").write(body); print(out); return
            d = json.loads(body)
            url = d.get("download_url") or (d.get("data") or {}).get("download_url")
            if url:
                open(out, "wb").write(urllib.request.urlopen(url, timeout=180).read()); print(out); return
        except urllib.error.HTTPError as e:
            if e.code not in (404, 425):
                print(f"  retrieve {e.code}: {e.read().decode()[:120]}", file=sys.stderr)
    sys.exit("timed out waiting for the render")

# ── commands ──────────────────────────────────────────────────────────────────
def cmd_image(a, key):
    body = post("/image/generate", {"model": a.model, "prompt": a.prompt, "aspect_ratio": a.aspect}, key).read()
    save_bytes_or_json(body, a.out); print(a.out)

def cmd_edit(a, key):
    body = post("/image/edit", {"model": a.model, "image": data_url(a.image),
                                "prompt": a.prompt, "aspect_ratio": a.aspect, "output_format": "png"}, key).read()
    save_bytes_or_json(body, a.out); print(a.out)

def cmd_video(a, key):
    payload = {"model": a.model, "image_url": data_url(a.image), "prompt": a.prompt, "duration": a.duration}
    if a.consent:  # experimental: attest you hold rights to a depicted human likeness
        payload["consent"] = {"consent_version": "v2.0", "accepted": True}
    try:
        q = json.load(post("/video/queue", payload, key))
    except urllib.error.HTTPError as e:
        msg = e.read().decode()
        if e.code == 409 and "consent" in msg:
            sys.exit("CONSENT_REQUIRED: this image contains a human face; Venice gates face→video behind a "
                     "likeness-consent attestation. Either animate it as a Ken Burns still "
                     "(assemble.py kenburns), or re-run with --consent if you hold the rights.")
        sys.exit(f"queue error {e.code}: {msg[:300]}")
    poll_queue("/video/retrieve", q.get("queue_id") or q.get("id"), a.model, key, a.poll, a.max_polls, a.out)

def cmd_tts(a, key):
    body = post("/audio/speech", {"model": a.model, "input": a.text, "voice": a.voice}, key).read()
    open(a.out, "wb").write(body); print(a.out)

def cmd_music(a, key):
    payload = {"model": a.model, "prompt": a.prompt}
    if a.duration:
        payload["duration_seconds"] = a.duration
    if a.instrumental:
        payload["force_instrumental"] = True
    q = json.load(post("/audio/queue", payload, key))  # NB: /audio/quote rejects 'prompt'; queue directly
    poll_queue("/audio/retrieve", q.get("queue_id") or q.get("id"), a.model, key, a.poll, a.max_polls, a.out)

def cmd_models(a, key):
    d = json.load(get(f"/models?type={a.type}", key))
    for m in d.get("data", []):
        print(m.get("id"))

def cmd_voices(a, key):
    d = json.load(get("/models?type=tts", key))
    for m in d.get("data", []):
        if m["id"] == a.model:
            print(" ".join((m.get("model_spec", {}) or {}).get("voices", []) or []))

def cmd_balance(a, key):
    d = json.load(get("/api_keys/rate_limits", key))
    print(json.dumps(d.get("data", {}).get("balances", {})))

def main():
    p = argparse.ArgumentParser(description="Venice AI media studio CLI")
    p.add_argument("--key")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("image"); pi.add_argument("--prompt", required=True); pi.add_argument("--out", required=True)
    pi.add_argument("--model", default=DEFAULTS["image"]); pi.add_argument("--aspect", default="16:9"); pi.set_defaults(fn=cmd_image)

    pe = sub.add_parser("edit"); pe.add_argument("--image", required=True); pe.add_argument("--prompt", required=True)
    pe.add_argument("--out", required=True); pe.add_argument("--model", default=DEFAULTS["edit"]); pe.add_argument("--aspect", default="16:9"); pe.set_defaults(fn=cmd_edit)

    pv = sub.add_parser("video"); pv.add_argument("--image", required=True); pv.add_argument("--prompt", required=True)
    pv.add_argument("--out", required=True); pv.add_argument("--model", default=DEFAULTS["video"])
    pv.add_argument("--duration", default="5s"); pv.add_argument("--consent", action="store_true")
    pv.add_argument("--poll", type=int, default=8); pv.add_argument("--max-polls", dest="max_polls", type=int, default=75); pv.set_defaults(fn=cmd_video)

    pt = sub.add_parser("tts"); pt.add_argument("--text", required=True); pt.add_argument("--out", required=True)
    pt.add_argument("--model", default=DEFAULTS["tts"]); pt.add_argument("--voice", default="Brian"); pt.set_defaults(fn=cmd_tts)

    pm = sub.add_parser("music"); pm.add_argument("--prompt", required=True); pm.add_argument("--out", required=True)
    pm.add_argument("--model", default=DEFAULTS["music"]); pm.add_argument("--duration", type=int)
    pm.add_argument("--instrumental", action="store_true")
    pm.add_argument("--poll", type=int, default=8); pm.add_argument("--max-polls", dest="max_polls", type=int, default=75); pm.set_defaults(fn=cmd_music)

    pmo = sub.add_parser("models"); pmo.add_argument("--type", required=True, choices=["image", "video", "tts", "music"]); pmo.set_defaults(fn=cmd_models)
    pvo = sub.add_parser("voices"); pvo.add_argument("--model", default=DEFAULTS["tts"]); pvo.set_defaults(fn=cmd_voices)
    sub.add_parser("balance").set_defaults(fn=cmd_balance)

    a = p.parse_args()
    key = resolve_key(a.key)
    try:
        a.fn(a, key)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode()[:300]}")

if __name__ == "__main__":
    main()
