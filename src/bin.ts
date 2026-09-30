#!/usr/bin/env node
// The `battler` command. Checks the Node version before loading anything else, so an old Node
// gets a clear message instead of a confusing import error.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`battler needs Node.js 22 or newer; this is ${process.versions.node}. Update Node (https://nodejs.org) and try again.\n`);
  process.exit(1);
}
await import("./cli.ts");
