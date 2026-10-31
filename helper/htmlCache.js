const fs = require("fs");
const path = require("path");

// Keeps the raw HTML of every page the matcher fetches, so a later question
// about a product ("what else was on that page?", "what did the price say on
// the day we matched it?") is a file read rather than another live fetch —
// which matters here because a fetch costs a proxy request and the page may
// have changed or gone since.
//
// Layout: html_cache/<destination>/<sku>__<kind>.html, plus a .json sidecar
// recording the source URL and when it was captured, since the filename
// cannot carry those.
const CACHE_ROOT = process.env.HTML_CACHE_DIR || path.join(__dirname, "..", "html_cache");

// Off by default for SEARCH pages: at ~720 KB each, 2852 products x 2
// destinations is ~4 GB. Product pages are always kept — there is at most one
// per matched product, and they are the ones worth re-reading.
const CACHE_SEARCH_PAGES = process.env.HTML_CACHE_SEARCH === "1";

function safeName(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 120);
}

// Returns the path written, or null when nothing was stored. Never throws:
// losing a cache write must not cost a run its match.
function saveHtml(destination, sku, kind, url, html) {
  try {
    if (kind === "search" && !CACHE_SEARCH_PAGES) return null;
    if (typeof html !== "string" || html.length === 0) return null;

    const dir = path.join(CACHE_ROOT, safeName(destination));
    fs.mkdirSync(dir, { recursive: true });

    const base = `${safeName(sku)}__${safeName(kind)}`;
    const htmlPath = path.join(dir, `${base}.html`);

    fs.writeFileSync(htmlPath, html, "utf8");
    fs.writeFileSync(
      path.join(dir, `${base}.json`),
      JSON.stringify({ destination, sku, kind, url, bytes: html.length, capturedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );

    return htmlPath;
  } catch (err) {
    console.error("htmlCache: could not store", destination, sku, kind, "-", err.message);
    return null;
  }
}

module.exports = { saveHtml, CACHE_ROOT, CACHE_SEARCH_PAGES };
