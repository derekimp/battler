// Loaded before panel.js: if the panel fails to start, say why on the panel instead of leaving
// it blank.
(() => {
  const show = (msg) => {
    const view = document.getElementById("view");
    if (!view || view.dataset.started) return;
    view.innerHTML =
      '<section class="card error-card" style="margin-top:14px"><h2 style="color:var(--red)">battler couldn\'t start</h2><pre></pre>' +
      '<p class="muted" style="font-size:12.5px">Right-click here → Inspect → Console shows more. Reloading the extension at chrome://extensions may help.</p></section>';
    view.querySelector("pre").textContent = msg;
  };
  window.addEventListener("error", (e) => show(`${e.message}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`));
  window.addEventListener("unhandledrejection", (e) => show(String(e.reason?.stack ?? e.reason)));
  setTimeout(() => {
    const view = document.getElementById("view");
    if (view && !view.dataset.started && !view.children.length) show("The panel script didn't run (a file may be missing or failed to load).");
  }, 3000);
})();
