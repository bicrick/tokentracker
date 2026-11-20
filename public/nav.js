// Shows the latest published CLI version next to the logo, straight from npm.
const el = document.getElementById('version');
if (el) {
  fetch('https://registry.npmjs.org/@bicrick/tokentracker/latest')
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => {
      if (!p?.version) return;
      el.textContent = `v${p.version}`;
      el.hidden = false;
    })
    .catch(() => {});
}
