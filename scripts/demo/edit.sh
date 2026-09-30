#!/bin/sh
# Usage: edit.sh <video-dir> <out-basename> [target seconds for the waiting part]
set -eu
dir=$1; out=$2; target=${3:-12}
webm=$(ls "$dir"/*.webm | head -1)
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$webm")
eval "$(node -e '
const m=require(process.argv[1]); const dur=+process.argv[2]; const target=+process.argv[3];
const off = Math.max(0, m.end - dur);           // the video starts a little after the script clock
const a1 = Math.max(0, m.start + 1.5 - off);    // after pressing Start
const b1 = m.verdict - off + 0.3;               // verdict shows
const speed = Math.max(1, (b1 - a1) / target);
console.log(`a1=${a1.toFixed(2)} b1=${b1.toFixed(2)} speed=${speed.toFixed(2)} skip=${Math.max(0, m.typing - off - 1).toFixed(2)}`);
' "$PWD/$dir/marks.json" "$dur" "$target")"
echo "cut: start=$skip a1=$a1 b1=$b1 speed=${speed}x (video ${dur}s)"
ffmpeg -v error -y -i "$webm" -filter_complex "
  [0:v]trim=$skip:$a1,setpts=PTS-STARTPTS[a];
  [0:v]trim=$a1:$b1,setpts=(PTS-STARTPTS)/$speed[b];
  [0:v]trim=$b1,setpts=PTS-STARTPTS[c];
  [a][b][c]concat=n=3:v=1,fps=30,format=yuv420p[v]" -map "[v]" -c:v libx264 -crf 20 -preset slow -movflags +faststart "$out.mp4"
rm -rf "$dir/frames" && mkdir -p "$dir/frames"
ffmpeg -v error -i "$out.mp4" -vf "fps=12,scale=960:-1:flags=lanczos" "$dir/frames/f%04d.png"
gifski --quiet --fps 12 --width 960 --quality 80 -o "$out.gif" "$dir"/frames/f*.png
ls -la "$out.mp4" "$out.gif"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$out.mp4"
