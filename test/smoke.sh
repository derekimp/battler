#!/bin/sh
# Runs the built CLI (dist/) end to end against the fake CLIs. Plain sh + node, so it works on
# Node versions that can't run the TypeScript tests directly.
set -eu
cd "$(dirname "$0")/.."
PATH="$PWD/test/fixtures/bin:$PATH"
# Never a real Antigravity CLI (it can sit next to node in ~/.local/bin).
BATTLER_AGY=agy-not-installed-in-tests
export PATH NO_COLOR=1 BATTLER_AGY
out_dir=$(mktemp -d)
json=$(node dist/cli.js --json -s -o "$out_dir" "Tabs or spaces?")
echo "$json" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const v = JSON.parse(s);
    if (!v.verdict || v.verdict.scorecard.length !== 3) throw new Error("bad verdict: " + s);
    console.log("smoke ok:", v.verdict.scorecard.map((x) => x.debater).join(", "));
  });'
node dist/cli.js --doctor

# The web app, from the built files: page, assets and API respond.
node dist/cli.js serve --no-open --port 4799 -o "$out_dir" >/dev/null 2>&1 &
serve_pid=$!
trap 'kill $serve_pid 2>/dev/null' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://localhost:4799/ >/dev/null && break; sleep 0.5; done
curl -sf http://localhost:4799/ | grep -q 'assets/app.js'
curl -sf http://localhost:4799/assets/app.js >/dev/null
curl -sf -H 'x-battler: 1' http://localhost:4799/api/battles | grep -q 'Tabs or spaces'
echo "serve ok"
