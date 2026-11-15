// Small UI kit for the Tab Saver app: icons, toasts with undo, menus, dialogs and a group picker.
// Menus and dialogs use <dialog>, which gives focus trapping and Esc handling for free.

import { escapeHtml } from "../lib/util.js";

export const icon = (id, cls = "") => `<svg class="ico ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

// ---------------------------------------------------------------------------
// Toast (one at a time). The last undoable action stays undoable (Ctrl+Z) until replaced.
// ---------------------------------------------------------------------------

let toastTimer = 0;
let lastUndo = null;

export function toast(message, { undo, duration } = {}) {
  const el = document.getElementById("toast");
  clearTimeout(toastTimer);
  if (undo) lastUndo = undo;
  el.innerHTML = `<span class="toast-msg">${escapeHtml(message)}</span>${undo ? `<button class="toast-btn" type="button">Undo</button>` : ""}`;
  el.querySelector(".toast-btn")?.addEventListener("click", () => runUndo());
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  toastTimer = setTimeout(hideToast, duration ?? (undo ? 6000 : 2600));
}

function hideToast() {
  const el = document.getElementById("toast");
  el.classList.remove("show");
  toastTimer = setTimeout(() => (el.hidden = true), 200);
}

export async function runUndo() {
  const fn = lastUndo;
  lastUndo = null;
  if (!fn) return false;
  try {
    await fn();
    toast("Undone");
  } catch (e) {
    console.error(e);
    toast("Couldn't undo that");
  }
  return true;
}
