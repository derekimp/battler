#!/bin/sh
# Usage: edit.sh <video-dir> <out-basename> [seconds each wait is squeezed into]
# Cuts the start, speeds up every waiting stretch listed in marks.json ("waits"), and exports an
# MP4 and a GIF.
set -eu
dir=$1; out=$2; target=${3:-6}
webm=$(ls "$dir"/*.webm | head -1)
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$webm")
filter=$(node -e '
const m = require(process.argv[1]); const dur = +process.argv[2]; const target = +process.argv[3];
const off = Math.max(0, m.end - dur);            // the video starts a little after the script clock
let t = Math.max(0, m.typing - off - 1);
const parts = [];
for (const [a0, b0] of m.waits) {
  const a = a0 - off, b = b0 - off;
  parts.push(`trim=${t.toFixed(2)}:${a.toFixed(2)},setpts=PTS-STARTPTS`);
  parts.push(`trim=${a.toFixed(2)}:${b.toFixed(2)},setpts=(PTS-STARTPTS)/${Math.max(1, (b - a) / target).toFixed(2)}`);
  t = b;
}
parts.push(`trim=${t.toFixed(2)},setpts=PTS-STARTPTS`);
const n = parts.length;
const chains = parts.map((p, i) => `[0:v]${p}[p${i}]`).join(";");
console.log(`${chains};${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${n}:v=1,fps=30,format=yuv420p[v]`);
' "$PWD/$dir/marks.json" "$dur" "$target")
ffmpeg -v error -y -i "$webm" -filter_complex "$filter" -map "[v]" -c:v libx264 -crf 20 -preset slow -movflags +faststart "$out.mp4"
rm -rf "$dir/frames" && mkdir -p "$dir/frames"
ffmpeg -v error -i "$out.mp4" -vf "fps=12,scale=960:-1:flags=lanczos" "$dir/frames/f%04d.png"
gifski --quiet --fps 12 --width 960 --quality 80 -o "$out.gif" "$dir"/frames/f*.png
ls -la "$out.mp4" "$out.gif"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$out.mp4"
