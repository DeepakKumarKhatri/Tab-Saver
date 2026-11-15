// Shared helpers used by the background worker and the app pages.

export const DAY = 86_400_000;

export function uid(prefix = "") {
  const a = crypto.getRandomValues(new Uint32Array(2));
  return prefix + a[0].toString(36) + a[1].toString(36).slice(0, 4);
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function debounce(fn, ms) {
  let timer = 0;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  run.now = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return run;
}
