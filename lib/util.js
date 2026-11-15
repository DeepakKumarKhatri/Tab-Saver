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

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi)$/i;

/**
 * Parse a URL once and return a dedupe key plus a display domain.
 * The key ignores http/https, "www.", trailing slashes and tracking params,
 * and maps every flavour of a YouTube video link to the same key.
 */
export function urlInfo(raw) {
  const url = String(raw || "");
  let u;
  try {
    u = new URL(url);
  } catch {
    return { key: url.trim(), domain: "" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { key: u.href.replace(/#.*$/, ""), domain: u.protocol === "file:" ? "file" : u.protocol.slice(0, -1) };
  }
  const domain = u.hostname.toLowerCase().replace(/^www\./, "");
  const bare = domain.replace(/^m\./, "");

  if (bare === "youtu.be") {
    const id = u.pathname.split("/")[1];
    if (id) return { key: "yt:" + id, domain: "youtube.com" };
  }
  if (bare === "youtube.com" || bare === "music.youtube.com") {
    const v = u.pathname === "/watch" && u.searchParams.get("v");
    if (v) return { key: "yt:" + v, domain };
    const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]+)/);
    if (m) return { key: "yt:" + m[2], domain };
  }

  const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k));
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  const hash = /^#[!/]/.test(u.hash) ? u.hash : ""; // keep hash routes like #/inbox
  const path = u.pathname.replace(/\/+$/, "");
  return { key: bare + (u.port ? ":" + u.port : "") + path + query + hash, domain };
}

export const urlKey = (raw) => urlInfo(raw).key;

/** Pages that make no sense to save: new tab pages, blank pages, Tab Saver itself. */
export function isSaveable(url) {
  if (!url || typeof url !== "string") return false;
  if (/^(about|data|javascript|blob|devtools|view-source):/i.test(url)) return false;
  if (/^[a-z-]+:\/\/(newtab|new-tab-page|local-ntp)/i.test(url)) return false;
  if (url.startsWith(chrome.runtime.getURL(""))) return false;
  return true;
}

export function titleFromUrl(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep the raw path */
    }
    return (u.hostname.replace(/^www\./, "") + path.replace(/\/+$/, "")).slice(0, 200) || url;
  } catch {
    return String(url || "");
  }
}

export function cleanTitle(title, url) {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 500) : titleFromUrl(url);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const F_MD = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const F_MDY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const F_MONTH = new Intl.DateTimeFormat(undefined, { month: "long" });
const F_MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const F_FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function shortDate(ts, now = Date.now()) {
  return new Date(ts).getFullYear() === new Date(now).getFullYear() ? F_MD.format(ts) : F_MDY.format(ts);
}

export const fullDate = (ts) => F_FULL.format(ts);

export function ago(ts, now = Date.now()) {
  const s = (now - ts) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 7 * 86400) return Math.floor(s / 86400) + "d ago";
  return shortDate(ts, now);
}

/** Section key for "group by date" (Today, Yesterday, Last 7 days, Last 30 days, then months). */
export function dateBucketKey(ts, today) {
  if (ts >= today) return "today";
  if (ts >= today - DAY) return "yesterday";
  if (ts >= today - 6 * DAY) return "week";
  if (ts >= today - 29 * DAY) return "month";
  const d = new Date(ts);
  return `m${d.getFullYear()}-${d.getMonth()}`;
}

export function dateBucketLabel(key, ts, today) {
  switch (key) {
    case "today":
      return "Today";
    case "yesterday":
      return "Yesterday";
    case "week":
      return "Last 7 days";
    case "month":
      return "Last 30 days";
    default: {
      const sameYear = new Date(ts).getFullYear() === new Date(today).getFullYear();
      return (sameYear ? F_MONTH : F_MONTH_YEAR).format(ts);
    }
  }
}
