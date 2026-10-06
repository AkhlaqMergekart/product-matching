const puppeteer = require("puppeteer");
const { PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD } = require("../config/proxy.js");
const { isBlockPage } = require("./blockDetect.js");

// The Webshare rotating endpoint (config/proxy.js) hands out a different exit
// IP per new connection, which is what replaces ScrapeOps' "escalate to
// premium after a failed attempt" behaviour — see fetchViaBrowser() for how
// each fetch is made to take a new connection.

// Headless Chrome's own UA string contains "HeadlessChrome", which is one of
// the cheapest bot signals there is. Present as ordinary desktop Chrome.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const NAVIGATION_TIMEOUT_MS = 90000;

// Nothing here ever looks at a rendered pixel — every extractor in
// config/targetSites.js reads the DOM via xpath — so images, fonts and media
// are pure cost. Blocking them cuts both page weight and proxy bandwidth
// substantially. Stylesheets are deliberately NOT blocked: some sites gate
// content rendering on their CSS having loaded.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

let browserPromise = null;

// One browser for the whole process, launched on first use. Pages are cheap
// and disposable; a browser launch is neither, and the old code paid for one
// per productMatching() call.
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        `--proxy-server=${PROXY_SERVER}`,
      ],
    });

    // Don't cache a rejected promise — a failed launch would otherwise make
    // every later call fail with the same stale error.
    browserPromise.catch(() => {
      browserPromise = null;
    });

    const browser = await browserPromise;
    browser.on("disconnected", () => {
      browserPromise = null;
    });
  }

  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;

  const pending = browserPromise;
  browserPromise = null;

  try {
    const browser = await pending;
    await browser.close();
  } catch (err) {
    console.error("Error closing browser:", err.message);
  }
}

// Fetches `url` in a real browser through the Webshare proxy and returns the
// fully rendered HTML.
//
// `options` mirrors what the old proxy clients accepted, so callers and
// config/targetSites.js entries don't need to change shape:
//   renderJs: false -> return as soon as the DOM is parsed instead of waiting
//                      for the network to go idle. Server-rendered fields
//                      (e.g. Amazon's brand table) are already present at
//                      that point, so the wait is pure latency for them.
//   headers         -> extra request headers forwarded to the target (locale,
//                      etc.)
//   country         -> accepted for config compatibility. The rotating
//                      endpoint picks its own exit geo, so this is NOT
//                      enforced any more; the storefront-language problem it
//                      used to address is handled by the "/-/en/" URL path
//                      (see config/targetSites.js).
async function fetchViaBrowser(url, options = {}) {
  const browser = await getBrowser();

  // Each fetch gets its own incognito context rather than just its own page.
  // That is what actually rotates the exit IP: Chrome pools proxy connections
  // per network context, so a second page in the shared default context
  // reuses the first one's tunnel and keeps its IP. Measured against
  // api.ipify.org — two pages in the default context both reported
  // 23.27.138.99, while two fresh contexts reported 107.175.56.181 and
  // 89.116.78.119. It also isolates cookies, so one site's session can't
  // follow us into the next request.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    // Must come before any navigation — Chrome asks for proxy credentials on
    // the very first request, and an unanswered challenge surfaces as
    // ERR_INVALID_AUTH_CREDENTIALS.
    await page.authenticate({
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    });

    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1366, height: 900 });

    if (options.headers && Object.keys(options.headers).length > 0) {
      await page.setExtraHTTPHeaders(options.headers);
    }

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    const response = await page.goto(url, {
      waitUntil: options.renderJs === false ? "domcontentloaded" : "networkidle2",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    // Surface HTTP failures as thrown errors so fetchHtml()'s retry loop sees
    // them, rather than handing an error page's HTML to the extractors and
    // reporting "no products found".
    if (!response) {
      throw new Error(`No response received for ${url}`);
    }
    if (response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} for ${url}`);
    }

    const html = await page.content();

    if (isBlockPage(html)) {
      throw new Error(`Blocked by anti-bot page (${html.length} bytes) for ${url}`);
    }

    return html;
  } finally {
    // Always tear down, including on the throw paths above — a leaked context
    // keeps a renderer process (and its memory) alive for the lifetime of the
    // run. Closing the context closes its pages with it.
    await context.close().catch(() => {});
  }
}

module.exports = { getBrowser, closeBrowser, fetchViaBrowser };
