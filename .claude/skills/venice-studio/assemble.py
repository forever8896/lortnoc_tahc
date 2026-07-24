#!/usr/bin/env python3
"""ffmpeg assembly helpers for venice-studio — turn generated stills/clips/voice/
music into a finished video. All clips are normalized to the same codec/size/fps
so they concat cleanly.

  python assemble.py kenburns --image shot.png --duration 6 --out s1.mp4 [--bw]
  python assemble.py clip     --in raw.mp4 --duration 5 --out s2.mp4
  python assemble.py concat   --out silent.mp4 --inputs s1.mp4 s2.mp4 s3.mp4
  python assemble.py vo       --out vo.mp3 --gap 0.4 --inputs l1.mp3 l2.mp3
  python assemble.py loopfit  --in bed.mp3 --duration 40 --out bedfit.mp3 [--fadein 1 --fadeout 2]
  python assemble.py mix      --video silent.mp4 --vo vo.mp3 --music bedfit.mp3 --out cut.mp4 [--music-vol 0.22]
  python assemble.py caption  --in cut.mp4 --out final.mp4 --text "FREE." --start 50 --end 53 --pos center --size 120
  python assemble.py probe    --in clip.mp4
"""
import argparse, os, subprocess, sys

W, H, FPS = 1280, 720, 30

def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("ffmpeg error:\n" + r.stderr[-1500:])

def font():
    r = subprocess.run(["fc-match", "-f", "%{file}", "sans:bold"], capture_output=True, text=True)
    return r.stdout.strip() or "/usr/share/fonts/noto/NotoSans-Bold.ttf"

def probe_dur(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1", path], capture_output=True, text=True)
    return float(r.stdout.strip())

def cmd_kenburns(a):
    frames = int(round(a.duration * FPS))
    extra = ",hue=s=0,eq=contrast=1.1" if a.bw else ""
    vf = (f"scale={2*W}:{2*H}:force_original_aspect_ratio=increase,crop={2*W}:{2*H},"
          f"zoompan=z='min(zoom+0.0006,1.25)':d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
          f"s={W}x{H}:fps={FPS}{extra},format=yuv420p")
    run(["ffmpeg", "-y", "-loop", "1", "-i", a.image, "-t", str(a.duration), "-r", str(FPS),
         "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", a.out])
    print(a.out)

def cmd_clip(a):
    vf = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},format=yuv420p"
    run(["ffmpeg", "-y", "-i", a.infile, "-t", str(a.duration), "-r", str(FPS), "-vf", vf,
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", a.out])
    print(a.out)

def cmd_concat(a):
    lst = a.out + ".txt"
    with open(lst, "w") as f:
        for c in a.inputs:
            f.write(f"file '{os.path.abspath(c)}'\n")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", a.out])
    os.remove(lst); print(a.out)

def cmd_vo(a):
    sil = a.out + ".sil.mp3"
    run(["ffmpeg", "-y", "-f", "lavfi", "-t", str(a.gap), "-i", "anullsrc=r=44100:cl=stereo", "-c:a", "libmp3lame", sil])
    lst = a.out + ".txt"
    with open(lst, "w") as f:
        for i, seg in enumerate(a.inputs):
            if i:
                f.write(f"file '{os.path.abspath(sil)}'\n")
            f.write(f"file '{os.path.abspath(seg)}'\n")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", a.out])
    os.remove(lst); os.remove(sil); print(a.out)

def cmd_loopfit(a):
    af = []
    if a.fadeout:
        af.append(f"afade=t=out:st={max(0, a.duration - a.fadeout):.2f}:d={a.fadeout}")
    if a.fadein:
        af.insert(0, f"afade=t=in:st=0:d={a.fadein}")
    args = ["ffmpeg", "-y", "-stream_loop", "8", "-i", a.infile, "-t", str(a.duration)]
    if af:
        args += ["-af", ",".join(af)]
    args += ["-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", a.out]
    run(args); print(a.out)

def cmd_mix(a):
    if a.vo and a.music:
        fc = f"[2:a]volume={a.music_vol}[m];[1:a][m]amix=inputs=2:duration=first:normalize=0[a]"
        run(["ffmpeg", "-y", "-i", a.video, "-i", a.vo, "-i", a.music, "-filter_complex", fc,
             "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", a.out])
    elif a.vo or a.music:
        track = a.vo or a.music
        vol = "1.0" if a.vo else str(a.music_vol)
        run(["ffmpeg", "-y", "-i", a.video, "-i", track, "-filter_complex", f"[1:a]volume={vol}[a]",
             "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", a.out])
    else:
        run(["ffmpeg", "-y", "-i", a.video, "-c", "copy", a.out])
    print(a.out)

def cmd_caption(a):
    y = {"top": "80", "center": "(h-text_h)/2", "bottom": "h-150"}[a.pos]
    txt = a.text.replace("\\", "").replace(":", r"\:").replace("'", "")
    dt = (f"drawtext=fontfile={font()}:text='{txt}':fontcolor={a.color}:fontsize={a.size}:"
          f"x=(w-text_w)/2:y={y}:enable='between(t,{a.start},{a.end})'")
    if a.box:
        dt += ":box=1:boxcolor=black@0.35:boxborderw=18"
    run(["ffmpeg", "-y", "-i", a.infile, "-vf", dt, "-c:a", "copy", a.out])
    print(a.out)

def cmd_probe(a):
    print(f"{probe_dur(a.infile):.2f}")

def main():
    p = argparse.ArgumentParser(description="ffmpeg assembly for venice-studio")
    sub = p.add_subparsers(dest="cmd", required=True)

    k = sub.add_parser("kenburns"); k.add_argument("--image", required=True); k.add_argument("--duration", type=float, required=True)
    k.add_argument("--out", required=True); k.add_argument("--bw", action="store_true"); k.set_defaults(fn=cmd_kenburns)

    c = sub.add_parser("clip"); c.add_argument("--in", dest="infile", required=True); c.add_argument("--duration", type=float, required=True)
    c.add_argument("--out", required=True); c.set_defaults(fn=cmd_clip)

    cc = sub.add_parser("concat"); cc.add_argument("--out", required=True); cc.add_argument("--inputs", nargs="+", required=True); cc.set_defaults(fn=cmd_concat)

    v = sub.add_parser("vo"); v.add_argument("--out", required=True); v.add_argument("--gap", type=float, default=0.4)
    v.add_argument("--inputs", nargs="+", required=True); v.set_defaults(fn=cmd_vo)

    lf = sub.add_parser("loopfit"); lf.add_argument("--in", dest="infile", required=True); lf.add_argument("--duration", type=float, required=True)
    lf.add_argument("--out", required=True); lf.add_argument("--fadein", type=float, default=0); lf.add_argument("--fadeout", type=float, default=0); lf.set_defaults(fn=cmd_loopfit)

    m = sub.add_parser("mix"); m.add_argument("--video", required=True); m.add_argument("--vo"); m.add_argument("--music")
    m.add_argument("--out", required=True); m.add_argument("--music-vol", dest="music_vol", type=float, default=0.22); m.set_defaults(fn=cmd_mix)

    cap = sub.add_parser("caption"); cap.add_argument("--in", dest="infile", required=True); cap.add_argument("--out", required=True)
    cap.add_argument("--text", required=True); cap.add_argument("--start", type=float, default=0); cap.add_argument("--end", type=float, default=9999)
    cap.add_argument("--pos", default="center", choices=["top", "center", "bottom"]); cap.add_argument("--size", type=int, default=54)
    cap.add_argument("--color", default="white"); cap.add_argument("--box", action="store_true"); cap.set_defaults(fn=cmd_caption)

    pr = sub.add_parser("probe"); pr.add_argument("--in", dest="infile", required=True); pr.set_defaults(fn=cmd_probe)

    a = p.parse_args(); a.fn(a)

if __name__ == "__main__":
    main()
