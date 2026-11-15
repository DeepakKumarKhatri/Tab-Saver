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

// ---------------------------------------------------------------------------
// Positioning for menus and pickers
// ---------------------------------------------------------------------------

function place(el, anchor) {
  const m = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x;
  let y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    if (x + w > vw - m) x = r.right - w;
    y = r.bottom + 4;
    if (y + h > vh - m && r.top - 4 - h >= m) y = r.top - 4 - h;
  } else if (anchor && typeof anchor.x === "number") {
    x = anchor.x;
    y = anchor.y;
    if (x + w > vw - m) x = anchor.x - w;
    if (y + h > vh - m) y = anchor.y - h;
  } else {
    x = (vw - w) / 2;
    y = Math.min(vh * 0.14, 90);
  }
  el.style.left = Math.round(Math.max(m, Math.min(x, vw - w - m))) + "px";
  el.style.top = Math.round(Math.max(m, Math.min(y, vh - h - m))) + "px";
}

function mountDialog(className, html) {
  const dlg = document.createElement("dialog");
  dlg.className = className;
  dlg.innerHTML = html;
  document.body.append(dlg);
  return dlg;
}

// ---------------------------------------------------------------------------
// Menu
//   items: { label, value, icon, hint, danger, disabled, checked } | { sep: true } | { header } | { swatches: [...], current }
//   Resolves with the chosen value, or null.
// ---------------------------------------------------------------------------

function menuItemHtml(it) {
  if (it.sep) return `<div class="m-sep" role="separator"></div>`;
  if (it.header) return `<div class="m-head">${escapeHtml(it.header)}</div>`;
  if (it.swatches) {
    return `<div class="m-swatches" role="group" aria-label="Color">${it.swatches
      .map(
        (c) =>
          `<button type="button" class="sw c-${c}${c === it.current ? " on" : ""}" data-value="color:${c}" title="${c}" aria-label="${c}"></button>`
      )
      .join("")}</div>`;
  }
  const lead = it.checked !== undefined ? `<span class="m-check">${it.checked ? icon("i-check") : ""}</span>` : it.icon ? icon(it.icon) : "";
  return `<button type="button" class="mi${it.danger ? " danger" : ""}" role="menuitem" data-value="${escapeHtml(it.value)}"${
    it.key ? ` data-key="${escapeHtml(it.key)}"` : ""
  }${it.disabled ? " disabled" : ""}>${lead}<span class="mi-label">${escapeHtml(it.label)}</span>${
    it.hint ? `<kbd>${escapeHtml(it.hint)}</kbd>` : ""
  }</button>`;
}

export function openMenu(anchor, items, { label = "Actions" } = {}) {
  return new Promise((resolve) => {
    const dlg = mountDialog("menu", `<div class="menu-in" role="menu" aria-label="${escapeHtml(label)}">${items.map(menuItemHtml).join("")}</div>`);
    const focusables = () => [...dlg.querySelectorAll("button:not(:disabled)")];
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(value ?? null);
    };
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) return close(null);
      const b = e.target.closest("button[data-value]");
      if (b && !b.disabled) close(b.dataset.value);
    });
    dlg.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      close(null);
    });
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    dlg.addEventListener("keydown", (e) => {
      const list = focusables();
      const i = list.indexOf(document.activeElement);
      if (e.key === "ArrowDown") list[(i + 1) % list.length]?.focus();
      else if (e.key === "ArrowUp") list[(i - 1 + list.length) % list.length]?.focus();
      else if (e.key === "Home") list[0]?.focus();
      else if (e.key === "End") list[list.length - 1]?.focus();
      else if (e.key === "Tab") list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const hit = dlg.querySelector(`button[data-key="${CSS.escape(e.key.toLowerCase())}"]:not(:disabled)`);
        if (!hit) return;
        close(hit.dataset.value);
      } else return;
      e.preventDefault();
    });
    dlg.showModal();
    place(dlg, anchor);
    dlg.querySelector("button.mi:not(:disabled)")?.focus();
  });
}
