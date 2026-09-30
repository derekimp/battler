#!/bin/sh
# Runs the built CLI (dist/) end to end against the fake CLIs. Plain sh + node, so it works on
# Node versions that can't run the TypeScript tests directly.
set -eu
cd "$(dirname "$0")/.."
PATH="$PWD/test/fixtures/bin:$PATH"
export PATH NO_COLOR=1
out_dir=$(mktemp -d)
json=$(node dist/cli.js --json -s -o "$out_dir" "Tabs or spaces?")
echo "$json" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const v = JSON.parse(s);
    if (!v.verdict || v.verdict.scorecard.length !== 3) throw new Error("bad verdict: " + s);
    console.log("smoke ok:", v.verdict.scorecard.map((x) => x.debater).join(", "));
  });'
node dist/cli.js --doctor
