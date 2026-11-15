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
  void el.offsetWidth; // start the fade-in transition from the hidden state
  el.classList.add("show");
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

// ---------------------------------------------------------------------------
// Dialog
//   buttons: [{ label, value, kind: "primary" | "danger" | "ghost" | "danger-ghost" }]
//   A button with an empty value cancels. Enter in a text field presses the primary button.
//   validate(value, dlg) may return an error message to keep the dialog open.
// ---------------------------------------------------------------------------

export function openDialog({ title, body = "", buttons = [], init, validate, wide = false }) {
  return new Promise((resolve) => {
    const dlg = mountDialog(
      "dlg" + (wide ? " wide" : ""),
      `<div class="dlg-in">
        <header class="dlg-head"><h2>${escapeHtml(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("i-x")}</button></header>
        <div class="dlg-body">${body}<p class="dlg-err" role="alert" hidden></p></div>
        ${
          buttons.length
            ? `<footer class="dlg-foot">${buttons
                .map((b) => `<button type="button" class="btn ${b.kind || ""}" data-value="${escapeHtml(b.value ?? "")}">${escapeHtml(b.label)}</button>`)
                .join("")}</footer>`
            : ""
        }
      </div>`
    );
    const err = dlg.querySelector(".dlg-err");
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(value || null);
    };
    const submit = async (value) => {
      if (!value) return close(null);
      if (validate) {
        const problem = await validate(value, dlg);
        if (problem) {
          err.textContent = problem;
          err.hidden = false;
          return;
        }
      }
      close(value);
    };
    const primary = buttons.find((b) => b.kind === "primary" || b.kind === "danger");
    dlg.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return close(null);
      const b = e.target.closest(".dlg-foot button[data-value]");
      if (b) submit(b.dataset.value);
    });
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("input[type=text], input[type=search], input:not([type])") && primary) {
        e.preventDefault();
        submit(primary.value);
      }
    });
    dlg.addEventListener("input", () => (err.hidden = true));
    dlg.showModal();
    if (init) init(dlg, { close, submit });
    else dlg.querySelector(".dlg-foot .primary, .dlg-foot .danger")?.focus();
  });
}

export async function promptText({ title, label = "", value = "", placeholder = "", okLabel = "Save", text = "", danger = false, maxLength = 120, validate }) {
  let result = null;
  const choice = await openDialog({
    title,
    body: `${text ? `<p class="dlg-text">${text}</p>` : ""}<label class="field">${label ? `<span class="field-label">${escapeHtml(label)}</span>` : ""}<input type="text" class="input" value="${escapeHtml(
      value
    )}" placeholder="${escapeHtml(placeholder)}" maxlength="${maxLength}" autocomplete="off" spellcheck="false"></label>`,
    buttons: [
      { label: "Cancel", value: "" },
      { label: okLabel, value: "ok", kind: danger ? "danger" : "primary" },
    ],
    init: (dlg) => {
      const input = dlg.querySelector("input");
      input.focus();
      input.select();
    },
    validate: (_v, dlg) => {
      const v = dlg.querySelector("input").value.trim();
      if (!v) return "Please type something first.";
      const problem = validate?.(v);
      if (problem) return problem;
      result = v;
      return "";
    },
  });
  return choice === "ok" ? result : null;
}

export async function confirmAction({ title, text = "", ok = "OK", danger = false }) {
  const choice = await openDialog({
    title,
    body: text ? `<p class="dlg-text">${text}</p>` : "",
    buttons: [
      { label: "Cancel", value: "" },
      { label: ok, value: "ok", kind: danger ? "danger" : "primary" },
    ],
  });
  return choice === "ok";
}

// ---------------------------------------------------------------------------
// Group picker: type to filter, Enter to pick, or create a new group by name.
//   groups: [{ id, name, color, private }]
//   Resolves { id } for an existing group, { create: name } for a new one, or null.
// ---------------------------------------------------------------------------

export function pickGroup(anchor, { title = "Move to", groups, currentId = null }) {
  return new Promise((resolve) => {
    const dlg = mountDialog(
      "menu picker",
      `<div class="menu-in">
        <div class="picker-title">${escapeHtml(title)}</div>
        <input class="input picker-input" type="text" placeholder="Find or create a group" autocomplete="off" spellcheck="false" aria-label="Group name">
        <div class="picker-list" role="listbox"></div>
      </div>`
    );
    const input = dlg.querySelector("input");
    const list = dlg.querySelector(".picker-list");
    let options = [];
    let active = 0;
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(value ?? null);
    };
    const paintActive = () => {
      list.querySelectorAll(".mi").forEach((b, i) => b.classList.toggle("on", i === active));
      list.querySelector(".mi.on")?.scrollIntoView({ block: "nearest" });
    };
    const render = () => {
      const q = input.value.trim();
      const ql = q.toLowerCase();
      const hits = groups.filter((g) => !ql || g.name.toLowerCase().includes(ql));
      options = hits.map((g) => ({
        id: g.id,
        html: `${g.private ? icon("i-lock", "pl-lead") : `<span class="gdot c-${g.color || "grey"}"></span>`}<span class="mi-label">${escapeHtml(g.name)}</span>${
          g.id === currentId ? `<span class="pl-note">current</span>` : ""
        }`,
      }));
      if (q && !groups.some((g) => g.name.toLowerCase() === ql)) {
        options.push({ create: q, html: `${icon("i-folder-plus")}<span class="mi-label">Create “${escapeHtml(q)}”</span>` });
      }
      active = Math.min(active, Math.max(0, options.length - 1));
      list.innerHTML = options.length
        ? options.map((o, i) => `<button type="button" class="mi" role="option" data-i="${i}">${o.html}</button>`).join("")
        : `<p class="picker-empty">Type a name to create your first group.</p>`;
      paintActive();
    };
    const choose = (i) => {
      const o = options[i];
      if (o) close(o.create ? { create: o.create } : { id: o.id });
    };
    input.addEventListener("input", () => {
      active = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!options.length) return;
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        paintActive();
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(active);
      }
    });
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (b) choose(Number(b.dataset.i));
    });
    list.addEventListener("mousemove", (e) => {
      const b = e.target.closest("[data-i]");
      if (b && Number(b.dataset.i) !== active) {
        active = Number(b.dataset.i);
        paintActive();
      }
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close(null);
    });
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    render();
    dlg.showModal();
    place(dlg, anchor);
    input.focus();
  });
}
