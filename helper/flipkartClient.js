const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD } = require("../config/proxy.js");
const { logEvent, step } = require("./timingLogger.js");

// Flipkart's mobile-site ("msite") JSON APIs, used by the "flipkart"
// destination (config/targetSites.js):
//
//   page/fetch      -> the search results page as JSON: product ids (pids)
//                      and product URLs for a query
//   serviceability  -> title, brand, price, MRP, rating and images for many
//                      pids in one call
//
// Flipkart refuses data-centre IPs, so every call goes through the Webshare
// rotating proxy (config/proxy.js). Verified 2026-11-01: 9 of 10 fresh exit
// IPs were served (the tenth timed out), well above the ~1 in 10 a fixed
// proxy list gets in the sellerpundit scraper.
//
// The APIs also expect a visitor session: cookies (T, SN, at, ...) that the
// homepage hands out. A session is bound to the exit IP that opened it, so
// each one holds its own keep-alive proxy tunnel (one tunnel = one IP), and
// changing session means a new tunnel and a new IP. A session also lives in
// one Flipkart data centre: calling the wrong <dc>.rome.api.flipkart.com
// answers 406 with the right dc in RESPONSE.id, and the call is re-sent
// there, as the mobile site does.

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const PROXY_URL = `http://${encodeURIComponent(PROXY_USERNAME)}:${encodeURIComponent(PROXY_PASSWORD)}@${PROXY_HOST}:${PROXY_PORT}`;
const HOME_URL = "https://www.flipkart.com/";
const PINCODE = process.env.FLIPKART_PINCODE || "110002";
const SESSION_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;
// The most pids the scraper sends serviceability in one call.
const SERVICEABILITY_BATCH = 25;

let session = null;

function apiHeaders(cookie) {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Origin: "https://www.flipkart.com",
    Referer: "https://www.flipkart.com/",
    "User-Agent": USER_AGENT,
    "X-User-Agent": `${USER_AGENT} FKUA/msite/0.0.3/msite/Mobile`,
    flipkart_secure: "true",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function mergeSetCookies(headers, jar) {
  for (const line of headers?.["set-cookie"] || []) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

const cookieHeader = (jar) => Object.entries(jar).map(([name, value]) => `${name}=${value}`).join("; ");

function dropSession(reason) {
  if (session) {
    logEvent(`  Flipkart session dropped after ${session.uses} call(s) — ${reason}`);
    session.agent.destroy();
  }
  session = null;
}

// Deliberately not called when a run ends: runs can overlap, and closing the
// shared session mid-call would cut off another run's request. An idle
// session simply expires (SESSION_TTL_MS) and is replaced on next use.
function closeFlipkartSession() {
  if (session) session.agent.destroy();
  session = null;
}

// Opens a session on a fresh exit IP: loads the homepage for its cookies (the
// ~1 MB body is dropped unread). Fails when the page doesn't hand out T and SN.
async function openSession() {
  const agent = new HttpsProxyAgent(PROXY_URL, { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 });
  try {
    const response = await axios.get(HOME_URL, {
      httpsAgent: agent,
      proxy: false,
      responseType: "stream",
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": USER_AGENT,
      },
    });
    response.data.destroy();

    const jar = mergeSetCookies(response.headers, {});
    if (response.status >= 400 || !jar.T || !jar.SN) {
      throw new Error(`no session from the homepage (HTTP ${response.status})`);
    }
    return { agent, jar, dc: "2", openedAt: Date.now(), uses: 0 };
  } catch (err) {
    agent.destroy();
    throw err;
  }
}

async function getSession() {
  if (session && Date.now() - session.openedAt > SESSION_TTL_MS) dropSession("session expired");
  if (!session) session = await openSession();
  return session;
}

// POSTs to a rome API path. A refused call (any non-200 other than the
// one-hop DC change, or a network error) drops the session — a new one comes
// with a new exit IP — and retries, up to MAX_ATTEMPTS sessions.
async function romePost(apiPath, body) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const current = await getSession();

      for (let hop = 0; hop < 2; hop++) {
        current.uses++;
        const response = await axios.post(`https://${current.dc}.rome.api.flipkart.com${apiPath}`, body, {
          httpsAgent: current.agent,
          proxy: false,
          timeout: REQUEST_TIMEOUT_MS,
          validateStatus: () => true,
          headers: apiHeaders(cookieHeader(current.jar)),
        });
        mergeSetCookies(response.headers, current.jar);

        const dc = response.status === 406 ? String(response.data?.RESPONSE?.id ?? "") : "";
        if (hop === 0 && /^\d+$/.test(dc) && dc !== current.dc) {
          current.dc = dc;
          continue;
        }
        if (response.status === 200) return response.data;
        throw new Error(`HTTP ${response.status} from ${apiPath}`);
      }
    } catch (err) {
      lastError = err;
      logEvent(`  Flipkart attempt ${attempt}/${MAX_ATTEMPTS} failed — ${err.code || err.message}`);
      dropSession(err.code || err.message);
    }
  }

  throw lastError;
}

// Product pages linked from the results, in result order, as { pid, url }.
// Links carry search tracking (q, lid, ctx, ...); path + pid is the canonical
// product page.
function extractResultLinks(pageData) {
  const seen = new Set();
  const links = [];
  for (const match of JSON.stringify(pageData).matchAll(/"url":"(\/[^"]*\/p\/[^"]*?[?&]pid=([A-Z0-9]{16})[^"]*)"/g)) {
    const pid = match[2];
    if (seen.has(pid)) continue;
    seen.add(pid);
    links.push({ pid, url: `https://www.flipkart.com${match[1].split("?")[0]}?pid=${pid}` });
  }
  return links;
}

async function searchPids(query, limit) {
  const data = await romePost("/api/4/page/fetch", {
    pageUri: `/search?q=${encodeURIComponent(query)}&marketplace=FLIPKART`,
    pageContext: { fetchSeoData: false },
    requestContext: { type: "BROWSE_PAGE" },
  });
  return extractResultLinks(data).slice(0, limit);
}

// pid -> serviceability entry, for every pid Flipkart knows.
async function fetchServiceability(pids) {
  const products = {};
  for (let i = 0; i < pids.length; i += SERVICEABILITY_BATCH) {
    const data = await romePost("/api/3/product/serviceability", {
      requestContext: {
        products: pids.slice(i, i + SERVICEABILITY_BATCH).map((productId) => ({ productId })),
        // superTitle is the brand; without it there's no brand to match on.
        showSuperTitle: true,
        marketplace: "FLIPKART",
      },
      locationContext: { pincode: PINCODE },
    });
    Object.assign(products, data?.RESPONSE || {});
  }
  return products;
}

// Searches Flipkart for `query` and returns up to `limit` results as
// { pid, url, product } — `product` being the serviceability entry. Results
// serviceability has nothing for are left out.
async function searchFlipkart(query, limit = 20) {
  const links = await step("Flipkart search", () => searchPids(query, limit), {
    summarize: (found) => `${found.length} product(s)`,
  });
  if (links.length === 0) return [];

  const products = await step("Flipkart serviceability", () => fetchServiceability(links.map((l) => l.pid)), {
    summarize: (found) => `${Object.keys(found).length} product(s)`,
  });

  return links.filter((link) => products[link.pid]).map((link) => ({ ...link, product: products[link.pid] }));
}

module.exports = { searchFlipkart, closeFlipkartSession };
