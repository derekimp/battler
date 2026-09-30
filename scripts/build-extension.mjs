// Assemble the Chrome extension in dist/extension: the files in extension/ plus the battle
// engine and renderers compiled from src/ (run `npm run build` first). No bundler needed: the
// compiled files are plain ES modules with relative imports.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "extension");
// What the side panel imports from the compiled engine; their own imports are followed from here,
// so a new file in src/core never gets left out.
const ENTRIES = ["core/battle.js", "core/saved-core.js", "core/verdict.js", "ui/html-report.js", "ui/markdown.js"];

function dependencies(entries) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(join(root, "dist", rel), "utf8");
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
      visit(relative(join(root, "dist"), resolve(dirname(join(root, "dist", rel)), spec)));
    }
  };
  entries.forEach(visit);
  return [...seen];
}
const LIB = dependencies(ENTRIES);

rmSync(out, { recursive: true, force: true });
cpSync(join(root, "extension"), out, { recursive: true });
for (const f of LIB) {
  mkdirSync(dirname(join(out, "lib", f)), { recursive: true });
  cpSync(join(root, "dist", f), join(out, "lib", f));
}
const { REPORT_CSS } = await import(join(root, "dist", "ui", "html-report.js"));
writeFileSync(join(out, "lib", "report.css"), REPORT_CSS());
// Also fill extension/lib (git-ignored), so loading the source folder itself works too.
rmSync(join(root, "extension", "lib"), { recursive: true, force: true });
cpSync(join(out, "lib"), join(root, "extension", "lib"), { recursive: true });
console.log(`Extension ready: ${out} (extension/ works too)\nLoad it at chrome://extensions → Developer mode → Load unpacked.`);
