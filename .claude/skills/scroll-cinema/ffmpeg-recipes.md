# ffmpeg recipes for scroll-cinema

`$N` = the normalizer used everywhere:
`scale=1152:648:force_original_aspect_ratio=increase,crop=1152:648,fps=24,setsar=1`

## Extract an exact last frame (chain point)
```bash
ffmpeg -y -sseof -0.05 -i seg.mp4 -frames:v 1 -q:v 2 chain.png   # -sseof BEFORE -i
```

## Ken Burns breathing loop from a still (label-safe, free)
```bash
ffmpeg -y -loop 1 -i still.png -vf "zoompan=z='1+0.0007*on':d=96:s=1152x648:fps=24" -frames:v 96 -an -c:v libx264 -crf 18 fwd.mp4
ffmpeg -y -i fwd.mp4 -vf reverse -an rev.mp4
printf "file 'fwd.mp4'\nfile 'rev.mp4'\n" > c.txt
ffmpeg -y -f concat -safe 0 -i c.txt -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart -an loop.mp4
```

## Seamless loop from a generated 5s clip (tail crossfades into head)
```bash
ffmpeg -y -i raw.mp4 -filter_complex \
 "[0:v]trim=end=4.0,setpts=PTS-STARTPTS[v0];[0:v]trim=start=4.0,setpts=PTS-STARTPTS[v1];\
  [v1][v0]xfade=transition=fade:duration=1:offset=0[vout]" \
 -map "[vout]" -an -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart loop.mp4
```

## Assemble the frame-chained film (hard cuts, joins are pixel-continuous)
```bash
ffmpeg -y -i a.mp4 -i t1.mp4 -i b.mp4 -filter_complex \
 "[0:v]$N[a];[1:v]$N[t];[2:v]$N[b];[a][t][b]concat=n=3:v=1:a=0[vout]" \
 -map "[vout]" -an -c:v libx264 -preset slow -crf 28 \
 -x264-params keyint=1:scenecut=0 -pix_fmt yuv420p -movflags +faststart film.mp4
```
`keyint=1:scenecut=0` (all-intra) is what makes scroll-scrubbing smooth; without it seeks snap to sparse keyframes and stutter.

## Verify joins (do this every time)
```bash
for t in 4.9 5.1 9.9 10.1; do ffmpeg -y -ss $t -i film.mp4 -frames:v 1 j-$t.png; done
montage j-*.png -tile 2x2 -geometry +2+2 joins.png   # then LOOK at it
```

## Night-grade a daylight photo (color work, not AI)
```bash
magick in.png -modulate 88,92 -fill '#2a1c0e' -colorize 12% -brightness-contrast -14x12 \
  -background black -vignette 0x60+10+10 night.png   # -background black or the vignette is WHITE
```

## Stabilize + grade shaky real footage into a usable act
```bash
ffmpeg -y -i seg.mp4 -vf vidstabdetect=shakiness=8:accuracy=15:result=s.trf -f null -
ffmpeg -y -i seg.mp4 -vf "vidstabtransform=input=s.trf:smoothing=30:optzoom=1:interpol=bicubic,\
 unsharp=5:5:0.4,setpts=PTS*1.15,scale=720:1280:flags=lanczos,\
 eq=contrast=1.09:saturation=1.05:brightness=-0.015,colorbalance=rh=.05:bh=-.06,\
 vignette=PI/4.4,noise=alls=5:allf=t+u" -an -c:v libx264 -preset slow -crf 23 graded.mp4
```
