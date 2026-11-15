// Development only: serve the extension folder as a normal website with a fake `chrome` API,
// so the UI can be tried in any browser.   node dev/serve.mjs   then open
//   http://localhost:5179/app.html?mode=page        (full page, 409 saved tabs)
//   http://localhost:5179/app.html                  (side panel layout: make the window narrow)
//   add &seed=legacy5000 or &seed=empty to change the data.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.PORT) || 5179;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const COLORS = ["#e8710a", "#1a73e8", "#188038", "#d01884", "#9334e6", "#00838f", "#d93025", "#5f6368"];

// Stand-in for Chrome's built-in favicon service: a coloured letter per website.
function fakeFavicon(pageUrl) {
  let host = "?";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {}
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) | 0;
  const letter = host[0]?.toUpperCase() || "?";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${COLORS[Math.abs(h) % COLORS.length]}"/><text x="16" y="22" font-family="Segoe UI, Arial" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/app.html";
    if (path.startsWith("/_favicon")) {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
      return res.end(fakeFavicon(url.searchParams.get("pageUrl")));
    }
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      let body = await readFile(file);
      if (path === "/app.html") {
        body = Buffer.from(body.toString().replace("<head>", '<head>\n    <script src="/dev/mock-chrome.js"></script>'));
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`Tab Saver dev harness: http://localhost:${port}/app.html?mode=page`));
