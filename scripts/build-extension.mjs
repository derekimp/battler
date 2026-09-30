// Assemble the Chrome extension in dist/extension: the files in extension/ plus the battle
// engine and renderers compiled from src/ (run `npm run build` first). No bundler needed: the
// compiled files are plain ES modules with relative imports.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "extension");
const LIB = [
  "core/battle.js",
  "core/prompts.js",
  "core/panel.js",
  "core/verdict.js",
  "core/types.js",
  "core/saved-core.js",
  "ui/markdown.js",
  "ui/html-report.js",
];

rmSync(out, { recursive: true, force: true });
cpSync(join(root, "extension"), out, { recursive: true });
for (const f of LIB) {
  mkdirSync(dirname(join(out, "lib", f)), { recursive: true });
  cpSync(join(root, "dist", f), join(out, "lib", f));
}
const { REPORT_CSS } = await import(join(root, "dist", "ui", "html-report.js"));
writeFileSync(join(out, "lib", "report.css"), REPORT_CSS());
console.log(`Extension ready: ${out}\nLoad it at chrome://extensions → Developer mode → Load unpacked.`);
