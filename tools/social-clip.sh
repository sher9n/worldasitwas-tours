#!/usr/bin/env bash
# Builds one vertical social clip for a walk, from the walk's own screenshots
# and the guide's own recorded voice.
#
# Screen recording was the obvious route and is the wrong one: the browser
# records no audio, and a narrated product with the narration stripped out is
# the one thing this must not be. Composing instead means the clip sounds like
# the walk actually sounds.
#
#   tools/social-clip.sh <tour_id>
set -euo pipefail
cd "$(dirname "$0")/.."
T="$1"
SHOTS="content/work/socials/shots"
TOUR="content/tours/$T"
OUT="content/work/socials/clips/$T.mp4"
SEG=8            # seconds per still
FADE=0.8         # crossfade between them
W=1080; H=1920   # the shape every platform wants for a vertical post

[ -f "$SHOTS/$T-cover.png" ] || { echo "no shots for $T" >&2; exit 1; }

# Her voice: the hello, then straight into the first thing she tells you.
# Trimmed to the length of the pictures and faded so it never cuts off mid-word.
TOTAL=$(python3 -c "print(3*$SEG - 2*$FADE)")
ffmpeg -v error -y \
  -i "$TOUR/companion_greeting.mp3" -i "$TOUR/s01_arrival_line.mp3" \
  -filter_complex "[0:a]afade=t=out:st=$(python3 -c "print(round($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TOUR/companion_greeting.mp3")-0.4,2))"):d=0.4[a0];
                   [1:a]atrim=0:$(python3 -c "print(round($TOTAL,2))"),asetpts=PTS-STARTPTS,adelay=200|200[a1];
                   [a0][a1]concat=n=2:v=0:a=1,atrim=0:$TOTAL,afade=t=out:st=$(python3 -c "print(round($TOTAL-1.2,2))"):d=1.2[out]" \
  -map "[out]" -c:a aac -b:a 160k "/tmp/_social_$T.m4a"

# Each still: a blurred, darkened copy of itself fills the frame behind, and the
# shot itself sits on top and drifts slowly closer. The phone shape is kept
# rather than cropped, because the shape is part of what is being shown.
# Two kinds of shot, because they want different treatment.
#
#   phone  a screenshot, kept in its phone shape on a blurred bed of itself.
#          The shape is part of what is being shown: this is an app.
#   full   one of the walk's own reconstructions, edge to edge. No interface at
#          all, just the place, which is what stops a thumb on a feed.
#
# Both drift by moving a fixed-size crop across a slightly larger picture rather
# than zooming. zoompan rescales every frame and cost eleven seconds of compute
# for two seconds of video; this costs half a second and reads the same.
seg() {
  local src="$1" out="$2" mode="$3" dir="$4"
  local pan
  if [ "$dir" = "down" ]; then pan="'(iw-OW)*t/$SEG':'(ih-OH)*t/$SEG'"; else pan="'(iw-OW)*(1-t/$SEG)':'(ih-OH)*(1-t/$SEG)'"; fi
  if [ "$mode" = "full" ]; then
    ffmpeg -v error -y -loop 1 -t "$SEG" -i "$src" \
      -vf "scale=$((W*11/10)):$((H*11/10)):force_original_aspect_ratio=increase,crop=$W:$H:$(echo "$pan" | sed "s/OW/$W/g; s/OH/$H/g"),format=yuv420p" \
      -r 25 -c:v libx264 -crf 20 -preset veryfast "$out"
  else
    ffmpeg -v error -y -i "$src" -vf "scale=$W:$H:force_original_aspect_ratio=increase,crop=$W:$H,boxblur=24:2,eq=brightness=-0.16" -frames:v 1 "/tmp/_bg_$T.png"
    ffmpeg -v error -y -loop 1 -t "$SEG" -i "/tmp/_bg_$T.png" -loop 1 -t "$SEG" -i "$src" -filter_complex "
      [1:v]scale=888:-2,crop=888:$H:0:$(echo "$pan" | cut -d: -f2 | sed "s/OH/$H/g")[fg];
      [0:v][fg]overlay=(W-w)/2:0,format=yuv420p[v]" \
      -map "[v]" -r 25 -c:v libx264 -crf 20 -preset veryfast "$out"
  fi
}

seg "$SHOTS/$T-cover.png"  "/tmp/_s1_$T.mp4" phone down
seg "$SHOTS/$T-clean1.png" "/tmp/_s2_$T.mp4" phone up
# Two further stops, so the clip travels rather than sitting still.
seg "$TOUR/s03_hero.jpg"   "/tmp/_s3_$T.mp4" full down

ffmpeg -v error -y -i "/tmp/_s1_$T.mp4" -i "/tmp/_s2_$T.mp4" -i "/tmp/_s3_$T.mp4" -i "/tmp/_social_$T.m4a" \
  -filter_complex "[0][1]xfade=transition=fade:duration=$FADE:offset=$(python3 -c "print($SEG-$FADE)")[a];
                   [a][2]xfade=transition=fade:duration=$FADE:offset=$(python3 -c "print(2*$SEG-2*$FADE)")[v]" \
  -map "[v]" -map 3:a -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p -g 50 \
  -c:a aac -b:a 160k -movflags +faststart -shortest "$OUT"

rm -f "/tmp/_s1_$T.mp4" "/tmp/_s2_$T.mp4" "/tmp/_s3_$T.mp4" "/tmp/_social_$T.m4a"
printf "%-34s %ss  %s MB\n" "$T" \
  "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -c1-4)" \
  "$(python3 -c "import os;print(round(os.path.getsize('$OUT')/1048576,1))")"
