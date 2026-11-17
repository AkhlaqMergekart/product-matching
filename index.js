const axios = require("axios");
const fs = require("fs");
const cheerio = require("cheerio");
const dom = require("xmldom").DOMParser;
const express = require("express");
const app = express();
const sendUpdateReportEmail = require("./helper/sendUpdateReport.js");
const { fetchHtml, closeFetchClients } = require("./helper/scrapeClient.js");
const { fetchJson } = require("./helper/httpClient.js");
const { exportResultsToExcel } = require("./helper/exportResults.js");
const { withFetchableImages } = require("./helper/sourceImages.js");
const { sourceSizeFromAsin } = require("./helper/pumaSourceTitle.js");
const { parseTechnosportAsin, colourMatches, sizeIsAvailable } = require("./helper/technosportSourceTitle.js");
const { parseSpeedoAsin, styleCodeInHandle } = require("./helper/speedoSourceTitle.js");
const { parseNewBalanceAsin, styleCodeMatches } = require("./helper/newBalanceSourceTitle.js");
const { saveHtml } = require("./helper/htmlCache.js");
const timing = require("./helper/timingLogger.js");
const targetSites = require("./config/targetSites.js");
const brandTargets = require("./config/brandTargets.js");

require("./database/config.js");

const ScratchProducts = require("./models/scratchProducts.js");

// Match policy: the brand must be right, and the service's own weighted score
// must be high enough.
//
// This replaces an AND of four independent 0.85 gates (title, brand, color,
// image_similarity), which was near-unsatisfiable in practice:
//
//   - `color` scored exactly 0 on 85.6% of candidates — 1605 of 11133 in the
//     597-product reference run — because neither the scraped candidates nor
//     the source rows carry a colour the service can compare. That one term
//     rejected most matches on its own.
//   - Across those same 11133 scored candidates, exactly ONE cleared all four.
//   - On SKU 175626 the per-gate maxima were title 0.848, brand 1.000,
//     color 0.000, image 0.860 — so the conjunction could never be true, and
//     title missed by 0.002 even ignoring colour.
//
// `composite_score` is the service's weighted combination of all seven field
// scores, which it already returns and which the old rule ignored entirely.
// Gating on it keeps the signal from title/image/price/model instead of
// discarding a candidate for one weak term.
// 0.30, not 0.85. The service scores brand by STRING SIMILARITY, not brand
// identity, so a partial name scores low even when it is the same brand —
// measured against the live service on 2026-11-01:
//   Stag Iconic vs STAG             -> 0.533
//   Adidas      vs Adidas Originals -> 0.545
//   HEAD        vs Head             -> 1.000
//   Babolat     vs NIVIA            -> 0.167  (genuinely unrelated)
// At 0.85 the first two were rejected outright however well title and images
// matched. 0.30 keeps unrelated brands out while admitting partial names.
// Replaying the 597-product reference run, 0.85 -> 0.30 admitted ZERO extra
// candidates, because composite_score already weights brand — so this only
// recovers matches that the hard gate was discarding, it does not loosen.
const BRAND_MATCH_THRESHOLD = 0.30;
// Overridable because the reachable composite depends on what the SOURCE rows
// carry, not only on how good the match is. The service's weights put 0.15 on
// price and 0.30 on image_similarity (app/config/weights.py), so a project
// whose rows have neither can never exceed 0.55 however perfect the match:
//
//   project 353 (Nahdi/Myntra/etc) -> rows carry price + images -> 0.70 is reachable
//   project 360 Puma               -> price "Not Found" and images NULL on
//                                     ALL 810 rows -> ceiling 0.550, so 0.70
//                                     is unreachable BY ARITHMETIC and every
//                                     product reports "no match" regardless of
//                                     how well title and brand agree.
//
// Default unchanged at 0.70 so existing destinations behave exactly as before.
// Set COMPOSITE_MATCH_THRESHOLD=0.45 (say) for a run over source rows that
// have no price and no images. Whatever is used is recorded on every output
// row under modelScore.thresholds, so a run stays interpretable later.
const COMPOSITE_MATCH_THRESHOLD = parseFloat(process.env.COMPOSITE_MATCH_THRESHOLD || "0.70");

// Secondary path. A candidate whose composite falls just short can still be a
// match when the TITLE and the IMAGE both agree strongly — marketplaces rename
// products ("Trousers" -> "Track Pants"), which drags the composite down even
// though it is plainly the same item.
//
// Title is required on purpose. The rejected alternative — "any 2 of
// (composite, brand, image) >= 0.80" — skips title, and since brand is 1.00
// for every same-brand candidate and image >= 0.80 for any two products in
// similar packaging, it reduces to "same brand, looks like the brand".
// Replayed over the 597-product reference run it matched Solgar Vitamin B12
// to Solgar Vitamin D3 (comp 0.60, brand 1.00, img 0.90), plus Biotin, D3
// 400 IU, D3 10000 IU and others onto that same listing.
//
// Measured on that run: this rule takes 17.1% -> 23.5% of products matched
// (+38) with no false positives observed, where the rejected one gave 41.4%
// with roughly one in four wrong.
const RESCUE_TITLE_THRESHOLD = 0.75;
const RESCUE_IMAGE_THRESHOLD = 0.70;
const RESCUE_BRAND_THRESHOLD = 0.80;

// Used by BOTH flows below, so the legacy SKU-list path and the brand path
// cannot drift apart on what counts as a match.
function clearsMatchThreshold(entry) {
    return matchDecision(entry).matched;
}

// Why a candidate did or did not match, as data rather than a boolean.
//
// clearsMatchThreshold() answers "is this a match?" but throws away WHICH rule
// decided and by how much, which is exactly what is needed when reviewing a
// run: a composite of 0.699 rejected and one of 0.701 accepted look identical
// in the output. `rule` is the rule that fired ("composite" | "rescue" |
// null), and the thresholds are recorded alongside the scores so a row stays
// interpretable after the constants above are retuned.
function matchDecision(entry) {
    const fieldScores = (entry && entry.field_scores) || null;
    if (!fieldScores) {
        return { matched: false, rule: null, reason: "no field_scores returned by the matching service" };
    }

    const composite = entry.composite_score || 0;
    const brand = fieldScores.brand || 0;
    const title = fieldScores.title || 0;
    const image = fieldScores.image_similarity || 0;

    if (brand >= BRAND_MATCH_THRESHOLD && composite >= COMPOSITE_MATCH_THRESHOLD) {
        return { matched: true, rule: "composite", reason: `composite ${composite.toFixed(3)} >= ${COMPOSITE_MATCH_THRESHOLD} and brand ${brand.toFixed(3)} >= ${BRAND_MATCH_THRESHOLD}` };
    }

    // Note: image_similarity is only computed for the candidates that reach
    // the image pass (IMAGE_SCORING_TOP_N), so this path can only rescue
    // candidates already in the top N by text score — which is the right
    // population anyway.
    if (title >= RESCUE_TITLE_THRESHOLD && image >= RESCUE_IMAGE_THRESHOLD && brand >= RESCUE_BRAND_THRESHOLD) {
        return { matched: true, rule: "rescue", reason: `title ${title.toFixed(3)}, image ${image.toFixed(3)}, brand ${brand.toFixed(3)} all cleared the rescue gates` };
    }

    // Name the gate that actually blocked it, most-informative first.
    let reason;
    if (brand < BRAND_MATCH_THRESHOLD) reason = `brand ${brand.toFixed(3)} < ${BRAND_MATCH_THRESHOLD}`;
    else if (composite < COMPOSITE_MATCH_THRESHOLD) reason = `composite ${composite.toFixed(3)} < ${COMPOSITE_MATCH_THRESHOLD}`;
    else reason = "no rule cleared";

    return { matched: false, rule: null, reason };
}

// The model's scores, flattened into one object that travels with every row.
//
// The nested service response is already written to products_matched_, but
// reading a score out of it means walking into matchedProducts.field_scores,
// which is awkward in a spreadsheet and absent entirely on a non-match. This
// is the flat, always-present form: every field score the service returned,
// the composite, the image aggregate, and the decision that was taken.
function modelScoreOf(entry) {
    if (!entry || !entry.field_scores) {
        return {
            composite_score: null,
            matched: false,
            match_rule: null,
            match_reason: "no candidate scored",
            title: null, description: null, brand: null, price: null,
            color: null, model: null, image_similarity: null,
            average_image_similarity: null,
            image_pairs_compared: 0,
            thresholds: {
                composite: COMPOSITE_MATCH_THRESHOLD,
                brand: BRAND_MATCH_THRESHOLD,
                rescue_title: RESCUE_TITLE_THRESHOLD,
                rescue_image: RESCUE_IMAGE_THRESHOLD,
                rescue_brand: RESCUE_BRAND_THRESHOLD,
            },
        };
    }

    const f = entry.field_scores;
    const decision = matchDecision(entry);
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

    return {
        composite_score: num(entry.composite_score),
        matched: decision.matched,
        match_rule: decision.rule,
        match_reason: decision.reason,
        // The seven weighted fields, exactly as app/config/weights.py names
        // them. Absent keys stay null rather than 0 — "not scored" and
        // "scored zero" are different facts, and conflating them is what made
        // the Foot Locker image diagnosis slow.
        title: num(f.title),
        description: num(f.description),
        brand: num(f.brand),
        price: num(f.price),
        color: num(f.color),
        model: num(f.model),
        image_similarity: num(f.image_similarity),
        // The service's own aggregate over every image pair it compared, and
        // how many pairs that was — 0 means the image pass never ran for this
        // candidate (it fell outside IMAGE_SCORING_TOP_N, or neither side had
        // a usable image URL).
        average_image_similarity: num(entry.average_image_similarity),
        image_pairs_compared: Array.isArray(entry.raw_image_results) ? entry.raw_image_results.length : 0,
        thresholds: {
            composite: COMPOSITE_MATCH_THRESHOLD,
            brand: BRAND_MATCH_THRESHOLD,
            rescue_title: RESCUE_TITLE_THRESHOLD,
            rescue_image: RESCUE_IMAGE_THRESHOLD,
            rescue_brand: RESCUE_BRAND_THRESHOLD,
        },
    };
}
const MATCHING_SERVICE_URL = "http://localhost:8000/api/match";

// Where every run report goes. Was five separate hardcoded addresses across
// this file (four akhlaq@, one anushidh@), so changing the recipient meant
// finding all five and missing one. Overridable with REPORT_EMAIL in the
// environment.
const REPORT_EMAIL = process.env.REPORT_EMAIL || "jaineel@mergekart.com";

function appendToFile(filename, data) {
    // Read the file
    return new Promise((resolve, reject) => {

        // Check if the file exists
        if (!fs.existsSync(filename)) {
            // If not, create it with an empty array
            fs.writeFileSync(filename, JSON.stringify([], null, 2), 'utf8');
        }

        fs.readFile(filename, 'utf8', (err, fileData) => {
            if (err) throw err;
            // Parse the JSON data
            let arr = JSON.parse(fileData);

            // Append the data
            if (Array.isArray(data)) {
                console.log(data.length);
                arr = arr.concat(data);
            } else {
                const found = arr.find(itm => itm === data);
                if (!found) {
                    arr.push(data);
                }
            }

            // Write the updated array back to the file
            fs.writeFile(filename, JSON.stringify(arr, null, 2), 'utf8', (err) => {
                if (err) reject(err);
                resolve();
            });
        });
    });
}

// Append-only, per-product ledger. One line per source product the moment it
// finishes, whatever the outcome — so an interrupted run can be resumed from
// the exact SKU it stopped on, rather than from the start of the chunk.
//
// Written with appendFileSync (O_APPEND, one small line) rather than the
// read-modify-write appendToFile() used for the JSON outputs: a crash
// mid-write can truncate those, and the ledger is the thing that has to
// survive exactly the crash it is there to recover from.
//
// JSONL, not JSON, for the same reason — no closing bracket to corrupt.
// `extra.asin` should be passed wherever one is available: a project can hold
// several VARIATION rows under one sku (project 360 keeps one row per size,
// distinguished only by asin — 810 rows across 275 skus), and a resume that
// keys on sku alone would skip every variation after the first. The runner
// script prefers `asin` over `sku` when deciding what is already done.
function recordProgress(projectId, destination, sku, outcome, extra) {
    try {
        const line = JSON.stringify(Object.assign({
            at: new Date().toISOString(),
            projectId: projectId,
            destination: destination,
            sku: String(sku),
            outcome: outcome
        }, extra || {}));
        fs.appendFileSync(`progress_${projectId}_${destination}.jsonl`, line + "\n", "utf8");
    } catch (err) {
        console.error("recordProgress failed for", sku, "-", err.message);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Ended-line summary for a fetched page in the timing log.
function describeHtml(html) {
    return typeof html === "string" ? `${Math.round(html.length / 1024)} KB` : "";
}

// Second pass for targets whose listing grid is *mostly* complete but drops a
// field on some cards. Fetches the product page for only those candidates,
// rather than making every candidate pay for the few that are short.
// Driven entirely by targetConfig.brandFallback — targets without it (Nahdi,
// Firstcry UAE) are untouched.
async function enrichMissingBrands(targetConfig, candidates) {
    const cfg = targetConfig.brandFallback;
    if (!cfg) return candidates;

    const gaps = candidates.filter((c) => cfg.needed(c));
    if (gaps.length === 0) return candidates;

    const limit = cfg.maxFetches ?? gaps.length;
    const toFetch = gaps.slice(0, limit);

    console.log(
        `  ${targetConfig.label}: ${gaps.length}/${candidates.length} candidates missing brand` +
        `, fetching ${toFetch.length} product page(s) to fill them in` +
        (gaps.length > toFetch.length ? ` (capped at ${limit})` : "")
    );

    // Cache by URL so repeated ASINs in one result set cost one fetch.
    const seen = new Map();

    for (let i = 0; i < toFetch.length; i++) {
        const candidate = toFetch[i];
        const url = cfg.buildUrl(candidate);
        if (!url) continue;

        if (seen.has(url)) {
            candidate.brand = seen.get(url);
            continue;
        }

        await delay(1000);

        try {
            const html = await timing.step(
                `${targetConfig.label} brand fallback page ${i + 1}/${toFetch.length} fetch`,
                () => fetchHtml(targetConfig.scraper, url, cfg.scraperOptions || targetConfig.scraperOptions),
                { detail: url }
            );
            const $ = cheerio.load(html);
            const brand = cfg.extract(new dom().parseFromString($.xml(), "text/xml")) || "";
            seen.set(url, brand);
            candidate.brand = brand;
        } catch (err) {
            // A failed top-up is not fatal — the candidate just keeps its blank
            // brand and will score 0 on that gate, exactly as it would have
            // without this pass at all.
            console.error(`  brand fallback failed for ${url}:`, err.message);
        }
    }

    return candidates;
}

// Turns a search-results page into candidates via the target's own JSON
// endpoint (targetConfig.detailApi), rather than one product-page fetch per
// candidate. Driven entirely by config, so a second site with a usable
// endpoint needs no changes here.
async function buildCandidatesFromApi(targetConfig, doc, query) {
    const cfg = targetConfig.detailApi;

    const skus = cfg.extractListingSkus(doc);
    if (skus.length === 0) {
        console.log(`No products found on ${targetConfig.label} for:`, query);
        return [];
    }

    // De-dupe before asking: a search page can link the same SKU more than
    // once, and the endpoint would just return it twice.
    const uniqueSkus = [...new Set(skus)];
    const batchSize = cfg.batchSize || uniqueSkus.length;
    const batchCount = Math.ceil(uniqueSkus.length / batchSize);
    const candidates = [];

    timing.logEvent(`${targetConfig.label} search page: ${uniqueSkus.length} product SKU(s) extracted`);

    for (let i = 0; i < uniqueSkus.length; i += batchSize) {
        const batch = uniqueSkus.slice(i, i + batchSize);

        if (i > 0) {
            await delay(1000);
        }

        let items;
        try {
            items = await timing.step(
                `${targetConfig.label} product API batch ${i / batchSize + 1}/${batchCount} fetch`,
                () => fetchJson(cfg.buildUrl(batch)),
                {
                    detail: `${batch.length} SKU(s)`,
                    summarize: (res) => (Array.isArray(res) ? `${res.length} item(s)` : ""),
                }
            );
        } catch (err) {
            // Lose this batch, keep the rest — same posture as a failed detail
            // page in the per-candidate path below.
            console.error(`Error fetching ${targetConfig.label} product API for ${batch.length} SKU(s):`, err.message);
            continue;
        }

        if (!Array.isArray(items)) {
            console.error(`Unexpected ${targetConfig.label} product API response (expected an array):`, typeof items);
            continue;
        }

        for (const item of items) {
            try {
                candidates.push(cfg.mapItem(item));
            } catch (err) {
                console.error(`Error mapping ${targetConfig.label} API item:`, err.message);
            }
        }
    }

    console.log(`  ${targetConfig.label}: ${uniqueSkus.length} SKU(s) on the search page -> ${candidates.length} candidate(s) from the product API`);

    return candidates;
}

// Mode S: the target's own search API answers a query with full candidates in
// one request (Mumzworld's Algolia index), so there is no search page to parse
// and no fetch per candidate. Throws when the request fails, so each caller
// keeps its own posture — the legacy flow retries, the brand flow skips.
async function buildCandidatesFromSearchApi(targetConfig, query) {
    const api = targetConfig.searchApi;

    // Logged with the query, not the URL: the request is a GET whose
    // credentials travel in headers, but the query is what's worth reading.
    const response = await timing.step(
        `${targetConfig.label} search API`,
        // A target may need a POST with a JSON body rather than a GET with the
        // query in the URL. New Balance's Algolia index is the case this
        // exists for: /1/indexes/*/queries takes the query in the body, and
        // the GET /1/indexes/<name>?query=... form answers HTTP 403 for its
        // public key — so a GET-only client simply cannot read it.
        () => fetchJson(api.buildUrl(query), {
            headers: api.headers(),
            ...(api.method === "POST"
                ? { method: "POST", data: api.buildBody(query) }
                : {}),
        }),
        { detail: query, summarize: (r) => `${api.extractHits(r).length} result(s)` }
    );

    const candidates = [];
    for (const hit of api.extractHits(response)) {
        try {
            candidates.push(api.mapHit(hit));
        } catch (err) {
            console.error(`Error mapping ${targetConfig.label} search result:`, err.message);
        }
    }

    timing.logEvent(`${targetConfig.label} search API: ${candidates.length} candidate(s)`);
    return candidates;
}

// Searches `targetConfig`'s site for `query` and returns a full list of
// candidate product objects, ready to hand to the matching service. This is
// the piece that used to be hardcoded to Nahdi — every site-specific fact
// (search URL, listing/detail selectors, which fetch strategy to use) comes
// from targetConfig (config/targetSites.js) instead.
async function buildCandidatesFromSearch(targetConfig, query) {
    if (targetConfig.searchApi) {
        try {
            return await buildCandidatesFromSearchApi(targetConfig, query);
        } catch (err) {
            console.error(`Error searching ${targetConfig.label} for "${query}":`, err.message);
            return [];
        }
    }

    const searchUrl = targetConfig.buildSearchUrl(query);

    let searchHtml;
    try {
        searchHtml = await timing.step(
            `${targetConfig.label} search page fetch`,
            () => fetchHtml(targetConfig.scraper, searchUrl, targetConfig.scraperOptions),
            { detail: searchUrl, summarize: describeHtml }
        );
    } catch (err) {
        console.error(`Error searching ${targetConfig.label} for "${query}":`, err.message);
        return [];
    }

    const $ = cheerio.load(searchHtml);
    const doc = new dom().parseFromString($.xml(), "text/xml");

    return buildCandidatesFromDoc(targetConfig, doc, query);
}

// Turns an already-fetched search-results document into candidates, picking one
// of three modes from the target's config. Split out from
// buildCandidatesFromSearch so the legacy flow — which fetches its own search
// page — goes through exactly the same logic instead of its own copy.
async function buildCandidatesFromDoc(targetConfig, doc, query) {
    // Mode A: a page per candidate (Nahdi, Firstcry UAE). The richest data —
    // full image gallery, description, real price — and affordable again now
    // that a page is a ~1-2s GET on a held-open proxy tunnel rather than a
    // ~13s browser navigation.
    if (targetConfig.needsDetailFetch) {
        const candidates = await buildCandidatesFromDetailPages(targetConfig, doc, query);

        // If every page failed, fall back to the site's bulk endpoint where one
        // is configured. Degraded (Nahdi's carries only the main image) but far
        // better than returning nothing for this source product.
        if (candidates.length === 0 && targetConfig.detailApi) {
            console.log(`  ${targetConfig.label}: no candidates from product pages, falling back to the bulk product API`);
            timing.logEvent(`${targetConfig.label}: no candidates from product pages, falling back to the bulk product API`);
            return buildCandidatesFromApi(targetConfig, doc, query);
        }

        return candidates;
    }

    // Mode B: the site has its own JSON endpoint and no detail-page pass. Read
    // the SKUs off the search page and fetch every candidate in one request.
    if (targetConfig.detailApi) {
        return buildCandidatesFromApi(targetConfig, doc, query);
    }

    // Mode C: some targets (Amazon UAE) carry enough data on the search-results
    // page itself, so there's no second request at all.
    const candidates = targetConfig.extractListingProducts(doc);
    timing.logEvent(`${targetConfig.label} search page: ${candidates.length} candidate(s) extracted`);
    return enrichMissingBrands(targetConfig, candidates);
}

// Mode A: one product page per candidate. A failed or unparseable page costs
// only its own candidate.
async function buildCandidatesFromDetailPages(targetConfig, doc, query) {
    const productLinks = targetConfig.extractListingLinks(doc);
    if (productLinks.length === 0) {
        console.log(`No products found on ${targetConfig.label} for:`, query);
        return [];
    }

    timing.logEvent(`${targetConfig.label} search page: ${productLinks.length} product link(s) extracted`);

    const candidates = [];
    for (let i = 0; i < productLinks.length; i++) {
        const link = productLinks[i];

        // Throttle between product detail requests. Kept even on the cheap
        // fetch path — the point is to look like a person reading a catalogue,
        // and the sticky exit IP is only worth holding if we don't hammer it.
        await delay(1000);

        let detailHtml = null;
        try {
            detailHtml = await timing.step(
                `${targetConfig.label} single product scrape ${i + 1}/${productLinks.length}`,
                () => fetchHtml(targetConfig.scraper, link, targetConfig.scraperOptions),
                { detail: link, summarize: describeHtml }
            );
        } catch (err) {
            console.error(`Error fetching ${targetConfig.label} product page:`, link, err.message);
            continue; // Skip this link, keep processing the rest of the batch
        }

        const $$ = cheerio.load(detailHtml);
        const detailDoc = new dom().parseFromString($$.xml(), "text/xml");

        try {
            candidates.push(targetConfig.extractDetail(detailDoc, link));
        } catch (err) {
            console.error(`Error parsing ${targetConfig.label} product page:`, link, err.message);
        }
    }

    console.log(`  ${targetConfig.label}: ${productLinks.length} product page(s) -> ${candidates.length} candidate(s)`);

    return candidates;
}

// What text to search a target with for a given source product. Most targets
// search on the title alone, which is what this has always done; a target can
// override it with `buildQuery` in config/targetSites.js — Myntra and Nykaa
// Fashion both ask for brand + title, since their relevance ranking leans on
// the brand token and our source titles don't always carry it.
//
// Centralised here (rather than at each call site) so the URL built for a
// search, the candidates collected from it, and the line written to the timing
// log can't disagree about what was actually searched for.
function searchQueryFor(targetConfig, sourceProduct) {
    if (typeof targetConfig.buildQuery === "function") {
        return targetConfig.buildQuery(sourceProduct);
    }
    return sourceProduct.title;
}

// Fields the matching service validates as strings. One non-string value in
// any of them gets the WHOLE request rejected with a 422 — seen with Nahdi's
// JSON-LD `brand: {"@type":"Brand","name":null}` — so they're coerced here
// whatever a site extractor produced.
const MATCH_TEXT_FIELDS = ["title", "brand", "category", "description", "sku", "url"];

function toText(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    // Schema.org-style objects ({ "@type": "Brand", "name": ... }).
    if (value && typeof value === "object" && typeof value.name === "string") return value.name;
    return "";
}

// Returns a copy for the request body; the caller's object is left as-is.
// null/undefined pass through untouched — the service already accepts those
// (it echoes `description: null` back), and turning them into "" isn't ours
// to decide.
function withStringTextFields(product) {
    const copy = { ...product };
    for (const field of MATCH_TEXT_FIELDS) {
        if (copy[field] == null) {
            // The service's schema types these as required strings, so a null
            // value makes it reject the WHOLE request with HTTP 422 — and the
            // caller writes an error row without a ledger outcome, so the
            // product is silently dropped rather than recorded as unmatched.
            // Project 353 has 555 rows with a null `title`, every one of which
            // was lost this way. "" scores as "no text" instead of failing.
            copy[field] = "";
        } else if (typeof copy[field] !== "string") {
            copy[field] = toText(copy[field]);
        }
    }

    // `price` is the other required field on the service's Product model
    // (`price: Union[float, str]`), and a null or NaN there 422s the WHOLE
    // batch exactly as a null title does. Candidates come from site
    // extractors, which can yield either, so they are coerced here too — the
    // source product is handled in callMatchingService, before this runs.
    copy.price = toNumericPrice(copy.price);
    if (copy.mrp != null && copy.mrp !== "") {
        copy.mrp = toNumericPrice(copy.mrp);
    }

    return copy;
}

// Which variation of its product a source row is — the identity that makes one
// of project 360's duplicate-looking rows distinct from the next.
//
// 810 Puma rows share only 275 skus and 275 titles, because the project holds
// one row PER SIZE and puts the size in `asin` rather than in the title or the
// `size` column. `asin` is unique across all 810, so it is the variation key;
// `size` here is its suffix (S/M/L/XL/XXL, 4-11, 128-176).
//
// Emitted on every output row so a consumer can tell the 7 size-rows of a shoe
// apart, which is otherwise impossible from title + sku alone.
function sourceVariationOf(sourceProduct, destination) {
    const asin = String(sourceProduct?.asin ?? "");
    const sku = String(sourceProduct?.sku ?? "");

    // Technosport encodes BOTH axes: "<styleCode>-<colour>-<size>"
    // ("W156-CF-MED", "B242-LGB-12Y") on all 433 rows of project 360, where
    // Puma's carries the size alone ("10927703-7"). Parsing it as Puma's would
    // read the size as "CF-MED" and lose the colour entirely, so the shape is
    // chosen by destination rather than guessed from the string.
    if (destination === "technosport") {
        const v = parseTechnosportAsin(asin, sku);
        return {
            asin,
            sku,
            // Folded onto the destination's own labels (SML -> S, 08Y -> 8Y).
            size: v.size,
            // The source's abbreviation ("CF"); the destination states the full
            // name ("Chili Flakes"), matched by colourMatches().
            colourToken: v.colourToken,
            hasSize: Boolean(v.size),
            hasColour: Boolean(v.colourToken),
        };
    }

    // Speedo appends the size to the sku with NO separator
    // ("81241101224" = "812411012" + "24"), so neither Puma's
    // last-hyphen-segment rule nor Technosport's three-part split applies —
    // the sku has to be stripped by prefix.
    // New Balance: "<STYLE>-<MID>-<SIZE>" on all 183 rows, but MID is a WIDTH
    // for footwear (D/B) and a COLOUR CODE for apparel (ABJ/DNT) — and `sku`
    // equals the style for footwear while concatenating style+colour for
    // apparel. Neither a startsWith nor a style+mid rule covers both, so the
    // size is taken as the LAST hyphen segment, which is uniform.
    if (destination === "newbalance") {
        const v = parseNewBalanceAsin(asin, sku);
        return {
            asin,
            sku,
            size: v.size,
            // Exactly one of these is set, by design: reporting a width as a
            // colour (or vice versa) would make the output misleading.
            width: v.width,
            colourCode: v.colourCode,
            // The code the destination actually indexes — NOT the sku, which
            // for apparel has the colour welded on.
            styleCode: v.styleCode,
            hasSize: v.hasSize,
        };
    }

    if (destination === "speedo") {
        const v = parseSpeedoAsin(asin, sku);
        return {
            asin,
            sku,
            // "04Y" normalised to "4Y"; numeric sizes (22-48) left as written.
            size: v.size,
            hasSize: v.hasSize,
            // 62 of the 313 rows are one-size items (caps, goggles, earplugs)
            // whose asin IS the bare sku. Stated so an absent size reads as
            // "this product has no size" rather than a parse failure.
            oneSize: !v.hasSize,
        };
    }

    const size = sourceSizeFromAsin(sourceProduct);
    return {
        // The per-row unique key.
        asin,
        // The parent product; shared by every size of the same item.
        sku,
        size,
        // False for accessories, whose asin is the bare sku with no suffix.
        hasSize: Boolean(size),
    };
}

// Does this CANDIDATE represent the same variation as the source row?
//
// The matching service scores text and images; it knows nothing about whether
// a candidate is the right COLOUR and the right SIZE. For a single-brand site
// that returns one result per colourway, that is the question that actually
// matters: "Women ... Tee - Black" and "Women ... Tee - Teal" score within
// 0.01 of each other, so the composite cannot choose between them, but the
// source row names exactly one of the two.
//
// Returns null for destinations where the source carries no variation axes, so
// the field is simply absent rather than misleadingly false.
function variationMatchOf(sourceVariation, candidate, destination) {
    if (!sourceVariation || !candidate) return null;

    // New Balance: identity is the STYLE CODE, which the index carries as the
    // colourway key of `styleData` and in the variant id / product URL. The
    // price term cannot help here at all — the US store quotes USD while the
    // source rows are INR — so the code is the only trustworthy signal.
    if (destination === "newbalance") {
        const wantSize = sourceVariation.size || "";
        const wantWidth = sourceVariation.width || "";
        const codeOk = styleCodeMatches(sourceVariation.styleCode, candidate);

        const sizes = Array.isArray(candidate.availableSizes) ? candidate.availableSizes : [];
        const widths = Array.isArray(candidate.availableWidths) ? candidate.availableWidths : [];

        // The index lists sizes as bare strings ("7.5", "M"); compare
        // case-insensitively and accept a trailing ".0" difference.
        const sizeOk = sizes.length === 0
            ? null
            : sizes.some((s) => {
                const a = String(s).trim().toUpperCase();
                const b = wantSize.toUpperCase();
                return a === b || a.replace(/\.0$/, "") === b.replace(/\.0$/, "");
            });

        // Widths read "Standard (M)" / "Wide (W)" on the index against a bare
        // "D"/"B" in the feed, so a letter inside the brackets counts as a
        // match. Only meaningful for footwear; null when the row has no width.
        const widthOk = !wantWidth
            ? null
            : (widths.length === 0
                ? null
                : widths.some((w) => new RegExp(`\\(${wantWidth}\\)|\\b${wantWidth}\\b`, "i").test(String(w))));

        return {
            styleCodeMatch: codeOk,
            colourMatch: null,
            sizeAvailable: sizeOk,
            widthAvailable: widthOk,
            // The code proves the product; the size must also be sold in it.
            // Width is advisory — the index does not list widths for apparel.
            exact: codeOk && sizeOk === true,
            wantSize,
            wantWidth,
            availableSizes: sizes,
            availableWidths: widths,
        };
    }

    // Speedo: identity comes from the STYLE CODE IN THE HANDLE, not from a
    // field. Its search cannot find the code, but every product URL ends with
    // it ("...-jammer-dark-teal-812411012"), so a handle containing the
    // source's sku is proof of the same product.
    //
    // Size is matched against the candidate's VARIANT list, which only exists
    // after the product page has been fetched (suggest.json ships
    // `variants: []`). Until then `sizeAvailable` is null — unknown, not false.
    if (destination === "speedo") {
        const wantSize = sourceVariation.size || "";
        const codeOk = styleCodeInHandle(sourceVariation.sku, candidate);

        // Speedo writes sizes as "24 (5-6Y)" — a numeric size plus an age
        // range — so a bare "24" has to match on the leading token rather than
        // the whole label.
        //
        // The sizes come from the DETAIL payload, not the search payload:
        // suggest.json ships `variants: []`, so `candidate.availableSizes` is
        // always empty and reading only that reported "size unknown" for every
        // candidate even after the product JSON had been fetched successfully.
        const detailSizes = (() => {
            const fromSearch = Array.isArray(candidate.availableSizes) ? candidate.availableSizes : [];
            if (fromSearch.length) return fromSearch;
            const d = candidate.detail;
            if (d && !d.error) {
                if (Array.isArray(d.variants) && d.variants.length) {
                    return d.variants.map((v) => String(v.size || "").trim()).filter(Boolean);
                }
                if (d.sizesAll) return String(d.sizesAll).split(",").map((s) => s.trim()).filter(Boolean);
            }
            return [];
        })();
        const sizeOk = detailSizes.length === 0
            ? null
            : detailSizes.some((label) => {
                const l = String(label).trim().toUpperCase();
                const w = wantSize.toUpperCase();
                if (!w) return false;
                if (l === w) return true;
                // leading numeric/letter token of "24 (5-6Y)"
                const head = l.split(/[\s(]/)[0];
                if (head === w) return true;
                // the age range in brackets, against a "<n>Y" source size
                const years = /^(\d{1,2})Y$/.exec(w);
                const range = /\((\d{1,2})\s*-\s*(\d{1,2})Y\)/.exec(l);
                return Boolean(years && range
                    && Number(years[1]) >= Number(range[1])
                    && Number(years[1]) <= Number(range[2]));
            });

        return {
            styleCodeMatch: codeOk,
            // Speedo's listing title carries the colour but the source row
            // does not, so there is nothing to compare — null, not false.
            colourMatch: null,
            sizeAvailable: sizeOk,
            // A one-size item (62 of the 313 rows) is exact on the code alone:
            // there is no size to agree about.
            exact: codeOk && (sourceVariation.oneSize ? true : sizeOk === true),
            wantSize,
            availableSizes: detailSizes,
            handle: String(candidate.handle || ""),
        };
    }

    if (destination !== "technosport") return null;

    const wantColour = sourceVariation.colourToken || "";
    const wantSize = sourceVariation.size || "";

    const gotColour = candidate.color || "";
    const sizes = Array.isArray(candidate.availableSizes) ? candidate.availableSizes : [];

    // Colour: the source abbreviates ("CF"), the destination spells it out
    // ("Chili Flakes"). colourMatches() only returns true on positive
    // evidence, so `false` here means "not shown to be the same colour".
    const colourOk = Boolean(wantColour && gotColour && colourMatches(wantColour, gotColour));

    // Size: the candidate lists the sizes its colourway is sold in, already
    // folded onto the same labels by parseTechnosportAsin (SML -> S).
    // sizeIsAvailable, not an equality: kids sizes are RANGES on the
    // destination ("7-8Y") against a single age in the source ("8Y").
    const sizeOk = sizeIsAvailable(wantSize, sizes);

    // The style code is the strongest signal of all — it is Technosport's own
    // product id, so an equal code means the same product beyond doubt.
    const wantCode = String(sourceVariation.sku || "").toUpperCase();
    const gotCode = String(candidate.styleCode || "").toUpperCase();
    const codeOk = Boolean(wantCode && gotCode && wantCode === gotCode);

    return {
        styleCodeMatch: codeOk,
        colourMatch: colourOk,
        sizeAvailable: sizeOk,
        // All three agreeing is an exact variation hit: same product, same
        // colourway, and the size we hold is actually sold in it.
        exact: codeOk && colourOk && sizeOk,
        wantColour,
        gotColour,
        wantSize,
        availableSizes: sizes,
    };
}

// A price the matching service will accept: a finite number, never NaN, null
// or undefined.
//
// Three separate things produce a value this has to absorb:
//   - ScratchProducts stores unknown prices as the STRING "Not Found"
//     (project 360: all 810 Puma rows), which parseFloat turns into NaN
//   - JSON.stringify serialises NaN as `null`, which the service rejects with
//     a 422 that fails the entire batch rather than the one field
//   - site extractors occasionally yield "" or a currency-prefixed string
//
// 0 is the right fallback rather than omitting the field: the service scores
// price similarity, and an unknown price should score 0 for that term instead
// of discarding the candidate's title, brand and image agreement with it.
function toNumericPrice(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (value == null) return 0;

    // Strip currency symbols, thousands separators and spaces: "AED 1,299.00",
    // "₹8,999", "Not Found".
    const cleaned = String(value).replace(/[^0-9.]/g, "");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
}

// Rewraps an axios failure so its message carries the service's own reason —
// FastAPI's 422 `detail` says which field of which candidate it rejected,
// which "Request failed with status code 422" does not. That message is what
// lands in the errors file and the timing log. The candidates' SKUs are
// included, in request order, because `detail` locates a candidate only by
// its index in comparable_products.
function matchingServiceError(err, candidates) {
    if (!err.response) return err;

    const body = typeof err.response.data === "string" ? err.response.data : JSON.stringify(err.response.data);
    const reason = body && body.length > 1000 ? `${body.slice(0, 1000)}…` : body;
    const skus = candidates.map((p) => p.sku).join(", ");

    const wrapped = new Error(`Matching service returned HTTP ${err.response.status}: ${reason} (candidate SKUs in order: ${skus})`);
    wrapped.status = err.response.status;
    wrapped.responseData = err.response.data;
    return wrapped;
}

// Sends originalProduct + every candidate to the matching microservice in ONE
// request, image similarity included, and returns its field-score results.
// This used to go in batches of 5, but the service's cost is almost all in
// the first call for a product (~2.5s; each later call ~0.06s, per the
// Beesline project 349 timing logs of 2026-10-12), so the extra round trips
// bought nothing.
// How many candidates get the expensive image pass. The service scores text
// in ~1.3s for a whole page but ~9s PER CANDIDATE once images are on, so
// image-scoring all 50 is ~99% of a run's wall time. Measured 2026-10-31:
// concurrency does not help (1/2/4/8 workers all ~0.07 cand/s — the box is
// CPU-saturated by TensorFlow), so the only lever is comparing fewer.
// The eventual match was inside the top 5 by text score on every run checked.
// 0 disables the two-pass and scores everything, as before.
const IMAGE_SCORING_TOP_N = parseInt(process.env.IMAGE_SCORING_TOP_N || "10", 10);
// How many of the top-scored candidates get their product page fetched and
// enriched (images, description, specifications, rating, reviews + Nykaa brand
// figures). Enrichment used to run only for the single matched winner; this
// runs it for the top N candidates so every strong candidate carries detail.
const DETAIL_ENRICH_TOP_N = parseInt(process.env.DETAIL_ENRICH_TOP_N || "10", 10);
// How many candidate product pages are fetched at once during enrichment. These
// fetches run concurrently with the image pass; a small cap keeps the proxy from
// being hit with all N at the same instant.
const DETAIL_FETCH_CONCURRENCY = parseInt(process.env.DETAIL_FETCH_CONCURRENCY || "5", 10);

// Per-target override, because what a site tolerates is a property of the SITE.
// Speedo rate-limits hard: at the default 5 its product JSON endpoint returned
// HTTP 429 thirty-four times in a 20-row run, turning a ~1s fetch into ~15s of
// retries and making the whole run four times slower than it needs to be.
// A target states `detailFetchConcurrency` in config/targetSites.js; everything
// else keeps the shared default, so no other destination is slowed down.
function detailConcurrencyFor(targetConfig) {
    const n = parseInt(targetConfig && targetConfig.detailFetchConcurrency, 10);
    return Number.isFinite(n) && n > 0 ? n : DETAIL_FETCH_CONCURRENCY;
}

function buildMatchRequest(originalProduct, comparableProducts, includeImages) {
    return {
        method: 'post',
        maxBodyLength: Infinity,
        url: MATCHING_SERVICE_URL,
        headers: {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'content-type': 'application/json',
            'origin': 'https://www.mumzworld.com',
            'referer': 'https://www.mumzworld.com/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
            'X-API-Key': "test123#"
        },
        data: {
            // withFetchableImages: ScratchProducts stores Google Drive SHARE
            // links, which answer 200 with an HTML viewer page rather than an
            // image. helper/sourceImages.js rewrites them to a fetchable form.
            "original_product": withStringTextFields(withFetchableImages(originalProduct)),
            "comparable_products": comparableProducts.map(withStringTextFields),
            "include_image_similarity": includeImages
        },
        timeout: parseInt(process.env.MATCHING_SERVICE_TIMEOUT_MS || "600000", 10)
    };
}

async function requestMatch(originalProduct, comparableProducts, includeImages, label) {
    const response = await timing.step(
        label,
        () => axios.request(buildMatchRequest(originalProduct, comparableProducts, includeImages))
            .catch((err) => { throw matchingServiceError(err, comparableProducts); }),
        { detail: `${comparableProducts.length} candidate(s)` }
    );
    return Array.isArray(response.data) ? response.data : [];
}

// Fetches the MATCHED product's own page and pulls the fields that only exist
// there — images, description, specifications, rating and total ratings, plus
// Nykaa Fashion's brand figures (Years on Nykaa, Orders Fulfilled, Average
// Rating, Customer Ratings).
//
// This is needed because the matching service strips `images` to [] and
// returns no description or specifications, so the matched product as scored
// carries almost none of the detail worth reporting.
//
// One page per MATCHED product — not per candidate — so it adds a single
// fetch to a run that found something, and nothing at all to a run that did
// not. The raw HTML is cached (helper/htmlCache.js) so further fields can be
// pulled later without re-fetching.
async function enrichMatchedProduct(targetConfig, matchedProduct, sourceSku, kind) {
    const cfg = targetConfig.matchedDetail;
    if (!cfg) return null;

    const url = cfg.buildUrl(matchedProduct);
    if (!url) return null;

    // The HTML cache is keyed by sourceSku + kind, so enriching several
    // candidates for the same source product must pass a distinct kind
    // (e.g. "candidate-<candidateSku>") or they overwrite one another.
    const cacheKind = kind || "matched-product";

    // Product pages need their OWN fetch options, not the search page's.
    // `scraperOptions.mustContain` is a search-page marker — Puma's is
    // "product-list-item", the listing tile — and a product page legitimately
    // does not contain it, so reusing it here rejects every correctly fetched
    // PDP as a bad response and retries it to exhaustion. A target can state
    // the product-page marker as `matchedDetail.scraperOptions`; otherwise the
    // search options are used with `mustContain` dropped.
    const detailOptions = cfg.scraperOptions
        ? cfg.scraperOptions
        : (() => {
            const { mustContain, ...rest } = targetConfig.scraperOptions || {};
            return rest;
        })();

    try {
        // A target whose detail endpoint returns JSON rather than a web page
        // (`matchedDetail.expectJson`) must NOT go through the HTML path: the
        // cheerio/XML round trip below would mangle the payload into a DOM and
        // the extractor would see nothing. Speedo is the case this exists for —
        // its product detail is Shopify's /products/<handle>.json.
        if (cfg.expectJson) {
            const payload = await timing.step(
                `${targetConfig.label} product JSON fetch`,
                () => fetchJson(url, { headers: (detailOptions && detailOptions.headers) || {} }),
                { detail: url, summarize: (p) => `${Object.keys(p || {}).length} top-level key(s)` }
            );
            // Cached like the HTML so fields can be pulled later without
            // re-fetching; stringified because the cache stores text.
            const jsonFile = saveHtml(targetConfig.id, sourceSku, cacheKind, url, JSON.stringify(payload));
            const jsonDetail = cfg.extract(payload, url);
            if (jsonFile) jsonDetail.htmlFile = jsonFile;
            return jsonDetail;
        }

        const html = await timing.step(
            `${targetConfig.label} product page fetch`,
            () => fetchHtml(targetConfig.scraper, url, detailOptions),
            { detail: url, summarize: describeHtml }
        );

        const htmlFile = saveHtml(targetConfig.id, sourceSku, cacheKind, url, html);

        const $ = cheerio.load(html);
        const detail = cfg.extract(new dom().parseFromString($.xml(), "text/xml"), url);

        if (htmlFile) detail.htmlFile = htmlFile;
        return detail;
    } catch (err) {
        // A failed enrichment costs only the extra fields; the match itself is
        // already decided and written.
        console.error(`Could not enrich matched product ${url}:`, err.message);
        return { url, error: err.message };
    }
}

// Two passes: score every candidate on text alone (cheap), then re-score only
// the strongest handful with images (expensive). Returns the full candidate
// list either way, so nothing downstream sees a shorter set — the tail simply
// keeps its text-only scores.
// Runs `fn` over `items` with at most `limit` in flight at once. Used to fetch
// several candidate product pages concurrently without opening all of them on
// the proxy at the same instant.
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    const n = Math.min(limit, items.length) || 0;
    await Promise.all(Array.from({ length: n }, worker));
    return results;
}

// `enrichFn(product)` (optional) fetches a candidate's product-page detail. When
// given, the top candidates are enriched CONCURRENTLY with the image pass — the
// two slowest stages overlap instead of running back to back — and the detail is
// attached to each candidate as `.detail`.
async function callMatchingService(originalProduct, comparableProducts, enrichFn, detailConcurrency) {
    // parseFloat of a non-numeric price yields NaN, and JSON.stringify turns
    // NaN into `null` — which the service rejects outright, because `price` is
    // `Union[float, str]` and therefore required:
    //   loc: ["body","original_product","price","float"]  input: null  -> 422
    //
    // A 422 fails the WHOLE batch, so one unparseable source price discards
    // every candidate for that product. Project 360 stores the literal string
    // "Not Found" where a price is unknown — all 810 Puma rows — so every one
    // of them failed this way until this guard was added.
    //
    // toNumericPrice keeps NaN out; the service itself is content with either
    // a number or a numeric string, and scores an unknown price as 0.
    originalProduct.price = toNumericPrice(originalProduct.price);
    originalProduct.mrp = toNumericPrice(originalProduct.mrp);

    // Enriches the given candidates in parallel and attaches `.detail` to each.
    const enrichCandidates = async (candidates) => {
        if (typeof enrichFn !== "function" || candidates.length === 0) return;
        const details = await mapWithConcurrency(
            // Per-target when the caller supplied one (a site that rate-limits
            // needs a smaller pool), else the shared default.
            candidates,
            Number.isFinite(detailConcurrency) && detailConcurrency > 0
                ? detailConcurrency
                : DETAIL_FETCH_CONCURRENCY,
            (e) => enrichFn(e.product)
        );
        candidates.forEach((e, i) => { e.detail = details[i]; });
    };

    if (IMAGE_SCORING_TOP_N <= 0 || comparableProducts.length <= IMAGE_SCORING_TOP_N) {
        const scored = await requestMatch(originalProduct, comparableProducts, true, "Product matching");
        await enrichCandidates(scored.slice(0, DETAIL_ENRICH_TOP_N));
        return scored;
    }

    const textScored = await requestMatch(
        originalProduct, comparableProducts, false, "Product matching pass 1 (text only)"
    );
    if (textScored.length === 0) return textScored;

    // Only candidates that already clear the BRAND gate can ever be a match
    // (clearsMatchThreshold requires brand >= BRAND_MATCH_THRESHOLD), so
    // image-scoring the rest cannot change any outcome — it just costs ~8s
    // each. Pass 1 is ~0.02s for a whole page, which makes this filter free.
    //
    // When nothing clears the brand gate the image pass is skipped entirely:
    // that is the common case for a catalogue like project 353, where the
    // destination often does not stock the brand at all and the search returns
    // unrelated substitutes rather than nothing.
    const brandOk = textScored.filter(
        (e) => e.field_scores && e.field_scores.brand >= BRAND_MATCH_THRESHOLD
    );

    if (brandOk.length === 0) {
        timing.logEvent(`No candidate clears the brand gate — skipping the image pass (${textScored.length} candidate(s) scored on text only)`);
        // No image pass to overlap with here, but the top candidates are still
        // enriched so detail is present for every processed product.
        await enrichCandidates(textScored.slice(0, DETAIL_ENRICH_TOP_N));
        return textScored;
    }

    // The service returns candidates sorted by composite_score descending.
    const top = brandOk.slice(0, IMAGE_SCORING_TOP_N);
    const topSkus = new Set(top.map((e) => String(e.product && e.product.sku)));
    const rest = textScored.filter((e) => !topSkus.has(String(e.product && e.product.sku)));

    // Re-send the ORIGINAL candidate objects, not the ones the service echoed
    // back: its response strips `images` to [], so feeding those into the
    // image pass would compare against nothing and score 0 for every one.
    const bySku = new Map(comparableProducts.map((p) => [String(p.sku), p]));
    const topOriginals = top
        .map((e) => bySku.get(String(e.product && e.product.sku)))
        .filter(Boolean);

    if (topOriginals.length === 0) {
        await enrichCandidates(textScored.slice(0, DETAIL_ENRICH_TOP_N));
        return textScored;
    }

    // Run the image pass and the candidate-detail fetches CONCURRENTLY. The top
    // set is the same candidates either way, so enrichment does not need the
    // image scores — overlapping the two removes the detail fetches from the
    // critical path almost entirely. `enrichCandidates` attaches `.detail` to
    // the `top` entries, which are the same objects carried in `imageScored`'s
    // input ordering and merged below.
    const [imageScored] = await Promise.all([
        requestMatch(
            originalProduct, topOriginals, true,
            `Product matching pass 2 (images, top ${topOriginals.length} of ${brandOk.length} brand-matching)`
        ),
        enrichCandidates(top),
    ]);

    // Carry the detail fetched above (attached to `top`) onto the image-scored
    // results the service returns, matched by sku.
    const detailBySku = new Map(
        top.filter((e) => e.detail !== undefined)
           .map((e) => [String(e.product && e.product.sku), e.detail])
    );
    for (const e of imageScored) {
        const sku = String(e.product && e.product.sku);
        if (detailBySku.has(sku)) e.detail = detailBySku.get(sku);
    }

    // Image scores change the composite, so re-sort the merged list — the
    // callers take the FIRST candidate that clears, assuming best-first order.
    const merged = imageScored
        .concat(rest)
        .sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0));

    // Top-up pass: guarantee the FINAL top N carry detail.
    //
    // The concurrent pass above enriches the top N by pass-1 text score (the
    // brand-gated set that goes to the image pass). After this re-sort, a
    // text-only candidate from `rest` can outrank an image-scored one and land
    // inside the top N without detail — so the file's top N and the enriched
    // set were not the same candidates (measured: only ~58% of top-N slots had
    // detail). Enriching whatever is still missing keeps the overlap speedup
    // while making the guarantee hold, and costs extra fetches only for the
    // few candidates whose rank actually changed.
    const missingDetail = merged
        .slice(0, DETAIL_ENRICH_TOP_N)
        .filter((e) => e.detail === undefined);

    if (missingDetail.length) {
        timing.logEvent(`Detail top-up: ${missingDetail.length} of the final top ${DETAIL_ENRICH_TOP_N} lacked detail after re-sort`);
        await enrichCandidates(missingDetail);
    }

    return merged;
}

// Applies the "all four scores >= 0.85" rule (unchanged threshold) and
// returns the first candidate that clears it, or null.
function pickBestMatch(matchData) {
    for (let i = 0; i < matchData.length; i++) {
        const fieldScores = matchData[i].field_scores;

        if (clearsMatchThreshold(matchData[i])) {
            // Unwrap to the product itself. The matching service returns each
            // candidate inside a score envelope —
            //   { product: {...}, composite_score, field_scores, ... }
            // — and this used to hand back that whole envelope as
            // `matchedProduct`. helper/exportResults.js then read .title/.url/
            // .price straight off it, one level too shallow, so a candidate
            // that PASSED all four gates produced a spreadsheet row reading
            // "Matched: Yes" with blank title, URL and price. Invisible so far
            // only because nothing has ever passed.
            //
            // Nothing is lost by unwrapping here: the full envelope for every
            // candidate is already written to the raw JSON further down.
            const matchedProduct = matchData[i].product || matchData[i];
            return { matchedProduct, fieldScores };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// SKU-list flow behind POST /product-matching. Pulls source rows by SKU list +
// projectId, searches the destination marketplace for each one by title, and
// matches the candidates against the matching microservice.
//
// `destination` picks the marketplace searched (MATCHING_DESTINATIONS):
//   "nahdi"     -> Nahdi search page, then one product page per candidate
//                  (the original flow, and the default, so existing callers
//                  are unchanged).
//   "mumzworld" -> Mumzworld's search API, which returns every candidate in
//                  one request. Source rows are whatever the project holds,
//                  e.g. Nahdi products scraped into ScratchProducts.
//   "myntra" / "nykaafashion" / "footlocker"
//               -> one search page per source product, searched by brand +
//                  title, with every candidate read off that page's own
//                  hydration JSON. First page of results only.
//   "puma"      -> in.puma.com, the BRAND'S OWN site. Searched by title +
//                  variation with the brand token REMOVED (every product there
//                  is Puma), and its results are one tile per COLOURWAY rather
//                  than one per style — so a candidate row is already a
//                  specific variation. See config/targetSites.js and
//                  helper/pumaSourceTitle.js.
//   "technosport"
//               -> www.technosport.in, also the brand's own site and also
//                  brand-stripped, but Mode S: its search page is a Next.js
//                  shell that loads results client-side from UNBXD, so the
//                  Unbxd index is queried directly. The query is the STYLE
//                  CODE (the row's sku, and the last token of its title),
//                  which Technosport indexes as masterProductCode and which
//                  returns exactly that product's colourways. See
//                  helper/technosportSourceTitle.js.
// ---------------------------------------------------------------------------
//   "speedo"    -> www.speedo.in, the brand's own site on SHOPIFY. Mode S via
//                  Shopify's suggest.json. The style code is NOT searchable
//                  here (unlike Technosport's) but IS the tail of every
//                  product handle, so it verifies identity while the TITLE is
//                  the query — with its audience code expanded ("JM" ->
//                  "Boy's"), which took the measured hit rate from 55.9% to
//                  90.2%. See helper/speedoSourceTitle.js.
//   "newbalance" -> www.newbalance.com, the brand's own site on Salesforce
//                  Demandware + ALGOLIA. Mode S, but a POST search API: the
//                  query travels in the body, and the GET form answers 403.
//                  Unlike Speedo the STYLE CODE is searchable, so it is the
//                  primary query with the model name as the fallback. The US
//                  store prices in USD while the source rows are INR, so the
//                  price term cannot score — identity comes from the code.
const MATCHING_DESTINATIONS = ["nahdi", "mumzworld", "myntra", "nykaafashion", "footlocker", "puma", "technosport", "speedo", "newbalance"];

async function productMatching(brands, projectId, category, destination = "nahdi") {
    try {

        console.log("Starting product matching for brand:", brands.join(", "), "and projectId:", projectId, "and category:", category || "All", "and destination:", destination);

        if (!brands || brands.length == 0 || !projectId) {
            console.error("Brand and projectId are required parameters.");
            throw new Error("Brand and projectId are required parameters.");
        }

        if (!MATCHING_DESTINATIONS.includes(destination) || !targetSites[destination]) {
            throw new Error(`Unknown destination "${destination}"; expected one of: ${MATCHING_DESTINATIONS.join(", ")}.`);
        }

        const targetConfig = targetSites[destination];

        // The browser is launched (and the Webshare proxy authenticated)
        // lazily by helper/browserClient.js on the first fetch below. This
        // used to launch its own instance here with the same proxy but no
        // page.authenticate() call, so every request through it would have
        // been met with an unanswered proxy auth challenge.

        // for (var z = 0; z < brands.length; z++) {

        // const brand = brands[z];

        const sourceProducts = await ScratchProducts.findAll({
            where: {
                sku: { [Op.in]: brands.map(itm => itm.toString()) },
                projectId: projectId
            },
            // limit: 1,
            raw: true,
            attributes: ['title', 'url', 'brand', 'sku', 'asin', 'category', 'images', 'attributes', 'price', 'mrp']
        });

        const brand = sourceProducts[0].brand;

        console.log("Brand: ", sourceProducts[0].brand, "Source products count:", sourceProducts.length);

        let retryCount = 0;
        let lastProcessedIndex = -1;

        const outputFilePath = `products_matched_final_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const errorFilePath = `products_matching_errors_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const matchedFilePath = `products_matched_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const emptyFilePath = `emptyFile.json`
        const timingFilePath = timing.startRun(
            timing.timingLogPath(`${sourceProducts[0].brand}_${projectId}_${Date.now()}`),
            `${targetConfig.label} matching for brand ${brand}, project ${projectId}, ${sourceProducts.length} SKU(s)`
        );

        for (var x = 0; x < sourceProducts.length; x++) {

            const sourceProduct = sourceProducts[x];

            // Reset the retry counter only when we advance to a genuinely new
            // product. Retries keep the same index (via x = x - 1), so this keeps
            // the counter per-product instead of leaking across products.
            if (x !== lastProcessedIndex) {
                retryCount = 0;
                lastProcessedIndex = x;
            }

            timing.beginSku(
                sourceProduct.sku,
                `${x + 1}/${sourceProducts.length}${retryCount > 0 ? `, retry ${retryCount}` : ""}`
            );

            // Throttle between products to stay under proxy / site rate limits.
            await delay(1500);

            // A search-API destination (Mumzworld) returns the candidates
            // from this one request; a search-page destination (Nahdi)
            // returns HTML, turned into candidates below.
            const usesSearchApi = Boolean(targetConfig.searchApi);
            // Not necessarily sourceProduct.title — a target can ask for a
            // composed query (brand + title) via buildQuery.
            const searchQuery = searchQueryFor(targetConfig, sourceProduct);
            const url = usesSearchApi ? null : targetConfig.buildSearchUrl(searchQuery);

            console.log(x, searchQuery, url || `(${targetConfig.label} search API)`);

            let searchResult = null;
            try {
                // One attempt per pass — the retryCount loop below is what
                // retries, exactly as it did when this escalated ScrapeOps'
                // premium tier on retryCount >= 2. There's no tier to
                // escalate now; a retry gets a fresh browser context and
                // therefore a fresh rotating exit IP instead.
                searchResult = usesSearchApi
                    ? await buildCandidatesFromSearchApi(targetConfig, searchQuery)
                    : await timing.step(
                        `${targetConfig.label} search page fetch`,
                        // Was a bare fetchPage(), which hardcoded the plain-GET
                        // path regardless of what the target's config asked
                        // for. Nahdi (scraper: "axios") is unaffected — that
                        // IS the plain-GET path — but a destination needing a
                        // browser would silently have been fetched without one
                        // here, while the brand flow fetched it correctly.
                        () => fetchHtml(targetConfig.scraper, url, targetConfig.scraperOptions),
                        { detail: url, summarize: describeHtml }
                    );

                // Search pages are cached only when HTML_CACHE_SEARCH=1 — at
                // ~720 KB each they would be ~4 GB for a full two-destination
                // run, where the matched product pages are a few MB.
                saveHtml(targetConfig.id, sourceProduct.sku, "search", url, searchResult);
            } catch (err) {
                console.error("Error navigating to URL:", err);
                retryCount++;
                if (retryCount >= 3) {
                    console.error("Max retries reached for source product:", sourceProduct.title);
                    await appendToFile(errorFilePath, {
                        sourceProduct: sourceProduct,
                        error: "Max retries reached"
                    });
                    recordProgress(projectId, destination, sourceProduct.sku, "error", { asin: sourceProduct.asin, error: "Max retries reached" });
                    continue; // Skip to the next source product
                } else {
                    x = x - 1; // Decrement x to retry the current source product
                    continue; // Skip to the next source product
                }

            }

            let productBatches = [];
            if (usesSearchApi) {
                productBatches = searchResult;
            } else {
                const $ = cheerio.load(searchResult);

                const doc = new dom().parseFromString($.xml(), 'text/xml');

                // Shares the brand flow's dispatch (config/targetSites.js decides
                // the mode), so the two flows can't drift apart on how a Nahdi
                // product is read and the listing selector exists in exactly one
                // place. It does its own link extraction and its own empty check,
                // which is why the extraction that used to sit here is gone — the
                // productBatches.length check below covers the empty case.
                //
                // This is where the win is for a blocked run: the ~20 full Chrome
                // navigations per source product are now ~20 plain GETs sharing one
                // held-open proxy tunnel.
                try {
                    productBatches = await timing.step(
                        `${targetConfig.label} candidate collection`,
                        () => buildCandidatesFromDoc(targetConfig, doc, searchQuery),
                        { summarize: (c) => `${c.length} candidate(s)` }
                    );
                } catch (error) {
                    console.error(`Error building ${targetConfig.label} candidates:`, error);

                    await appendToFile(errorFilePath, {
                        sourceProduct: sourceProduct,
                        error: error.message
                    });

                    continue; // Skip to the next source product if there's an error
                }
            }

            // A target can offer a broader second query for when the first
            // returns nothing. Puma is the case this exists for: its search is
            // strict enough that an unrecognised colour name ("Alpine Snow")
            // returns zero hits for a product that is very much on the site,
            // so the colourway is dropped and matched per-candidate instead.
            //
            // Only ever runs when the first query found NOTHING, so it costs
            // one extra fetch on exactly the products that would otherwise
            // have been written off as "No products found".
            // Applies to SEARCH-API targets too, not just page-scraped ones.
            // The `!usesSearchApi` guard that used to be here silently disabled
            // the fallback for every Mode S destination — so New Balance's
            // three FuelCell codes reported "no products found" on 17 rows
            // although the model name ("FuelCell Rebel v5") finds them, and
            // Technosport's and Speedo's fallbacks were never reachable
            // either. The only difference between the two paths is HOW the
            // second query is fetched, which is handled below.
            if (productBatches.length === 0
                && typeof targetConfig.buildFallbackQuery === "function") {

                const fallbackQuery = targetConfig.buildFallbackQuery(sourceProduct);

                // Skip when it would repeat the query just tried (a source row
                // with no colourway parsed out of its title).
                if (fallbackQuery && fallbackQuery !== searchQuery) {
                    timing.logEvent(`No candidates for "${searchQuery}" — retrying with the broader query: "${fallbackQuery}"`);

                    try {
                        if (usesSearchApi) {
                            productBatches = await buildCandidatesFromSearchApi(targetConfig, fallbackQuery);
                        } else {
                            const fallbackUrl = targetConfig.buildSearchUrl(fallbackQuery);
                            const fallbackHtml = await timing.step(
                                `${targetConfig.label} search page fetch (fallback query)`,
                                () => fetchHtml(targetConfig.scraper, fallbackUrl, targetConfig.scraperOptions),
                                { detail: fallbackUrl, summarize: describeHtml }
                            );
                            saveHtml(targetConfig.id, sourceProduct.sku, "search-fallback", fallbackUrl, fallbackHtml);

                            const $fb = cheerio.load(fallbackHtml);
                            const fbDoc = new dom().parseFromString($fb.xml(), 'text/xml');
                            productBatches = await timing.step(
                                `${targetConfig.label} candidate collection (fallback query)`,
                                () => buildCandidatesFromDoc(targetConfig, fbDoc, fallbackQuery),
                                { summarize: (c) => `${c.length} candidate(s)` }
                            );
                        }
                    } catch (err) {
                        // The fallback is best-effort: a failure here leaves
                        // the original "no products found" outcome intact
                        // rather than turning it into a hard error.
                        timing.logEvent(`  Fallback query failed — ${err.message}`);
                    }
                }
            }

            if (productBatches.length === 0) {
                console.log("No products found for:", sourceProduct.title);
                timing.logEvent(`Result: no products found on ${targetConfig.label}`);
                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No products found"
                });
                recordProgress(projectId, destination, sourceProduct.sku, "no-candidates", { asin: sourceProduct.asin });
                continue; // Skip to the next source product if no products found
            }

            console.log("Found products in batch:", productBatches.length);

            let matchData = [];
            try {
                // The enrich callback fetches a candidate's product-page detail;
                // callMatchingService runs these concurrently with the image pass
                // and attaches the result to each top candidate as `.detail`.
                matchData = await callMatchingService(
                    sourceProduct, productBatches,
                    (product) => enrichMatchedProduct(
                        targetConfig, product, sourceProduct.sku,
                        `candidate-${product && product.sku}`
                    ),
                    detailConcurrencyFor(targetConfig)
                );
            } catch (error) {
                console.log(error);
                console.error("Error matching products:", error);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: error.message
                });

                // Record an outcome before moving on. Without this the product
                // never reaches the ledger, so the resume logic treats it as
                // never attempted and the run-project script hands it back on
                // every pass — and, because the chunk waits on ledger growth,
                // a batch of these stalls the loop for its full 30-minute
                // timeout. This is the path that silently dropped 555 products
                // of project 353 when a null title 422'd the batch.
                recordProgress(projectId, destination, sourceProduct.sku, "error", {
                    asin: sourceProduct.asin,
                    error: error.message,
                    candidates: productBatches.length,
                });

                continue; // Skip to the next source product if there's an error
            }

            if (matchData.length === 0) {
                console.log("No match data found for:", sourceProduct.title);
                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No match data found"
                });
                recordProgress(projectId, destination, sourceProduct.sku, "no-match-data", { asin: sourceProduct.asin });
                continue; // Skip to the next source product if no match data found
            }

            console.log("Match data found:", matchData.length);

            // callMatchingService has already enriched the top N candidates
            // (concurrently with the image pass) and attached `.detail` to each.
            // Index them by sku so the winner below can reuse its detail rather
            // than fetch the page a second time.
            const detailBySku = new Map();
            for (const cand of matchData) {
                const candSku = cand && cand.product && cand.product.sku;
                if (candSku != null && cand.detail !== undefined) {
                    detailBySku.set(String(candSku), cand.detail);
                }
            }

            // Every scored candidate, each carrying a flat `modelScore` beside
            // the service's nested response so the scores are readable without
            // walking into field_scores. `rank` is the candidate's position
            // after the image pass re-sorted them, which is the order that
            // actually decided the winner.
            //
            // `sourceVariation` names WHICH variation row this is. Project 360
            // holds one row per size and the rows of a product are otherwise
            // identical — same sku, same title, same colourway — with the size
            // only in `asin` ("10927703-7"). Without this the 7 size-rows of a
            // shoe are indistinguishable in the output.
            const srcVariation = sourceVariationOf(sourceProduct, destination);

            // The matching service ECHOES BACK only the fields its own Product
            // model declares, so the variation fields a site extractor added —
            // `color`, `styleCode`, `availableSizes` — are absent from
            // `entry.product`. Matching against that echo therefore sees no
            // colour at all and reports every candidate as a non-match.
            //
            // `productBatches` holds the candidates as the extractor built
            // them, so the variation match is made against those, looked up by
            // the sku that survives the round trip.
            const originalBySku = new Map();
            for (const cand of productBatches) {
                if (cand && cand.sku != null) originalBySku.set(String(cand.sku), cand);
            }
            // `detail` is attached to the SCORED ENTRY, not to `entry.product`,
            // so it has to be carried onto the original explicitly — otherwise
            // a destination whose sizes only exist in the detail payload
            // (Speedo: suggest.json ships `variants: []`) can never see them,
            // and reports "size unknown" for every candidate even after the
            // product JSON was fetched successfully.
            const originalOf = (product, detail) => {
                const key = product && product.sku != null ? String(product.sku) : "";
                const base = originalBySku.get(key) || product;
                if (detail === undefined) return base;
                return { ...base, detail };
            };

            await appendToFile(matchedFilePath, {
                sourceProduct: sourceProduct,
                sourceVariation: srcVariation,
                matchedProducts: matchData.map((entry, rank) => ({
                    ...entry,
                    rank: rank + 1,
                    modelScore: modelScoreOf(entry),
                    // Which candidate is the RIGHT colour and size. The model
                    // cannot tell two colourways of one product apart (their
                    // titles differ by one word), so this is the field that
                    // picks the variation the source row actually names.
                    variationMatch: variationMatchOf(srcVariation, originalOf(entry.product, entry.detail), destination),
                })),
            });

            let foundProductCount = 0;
            let matchedEntry = null;
            try {

                // The service returns candidates already sorted by
                // composite_score descending (verified against a live run),
                // so the first that clears is also the best that clears.
                for (var i = 0; i < matchData.length; i++) {

                    if (clearsMatchThreshold(matchData[i])) {
                        matchedEntry = matchData[i];
                        // Reuse the detail already fetched in the top-N pass
                        // when the winner is among them; only fetch here if the
                        // winner fell outside the enriched top N.
                        const winnerSku = matchData[i].product && matchData[i].product.sku;
                        const matchedDetail = (winnerSku != null && detailBySku.has(String(winnerSku)))
                            ? detailBySku.get(String(winnerSku))
                            : await enrichMatchedProduct(
                                targetConfig, matchData[i].product, sourceProduct.sku,
                                `candidate-${winnerSku}`
                            );

                        const finalObj = {
                            sourceProduct: sourceProduct,
                            sourceVariation: srcVariation,
                            matchedProducts: matchData[i],
                            matchedDetail: matchedDetail,
                            // Whether the WINNER is the right colour/size, not
                            // merely the best-scoring text match.
                            variationMatch: variationMatchOf(srcVariation, originalOf(matchData[i].product, matchedDetail), destination),
                            // The winner's scores, flat. Same shape as the
                            // per-candidate modelScore above, so the final file
                            // and the all-candidates file can be read the same
                            // way.
                            modelScore: modelScoreOf(matchData[i]),
                            // Where the winner sat in the ranked list. Usually
                            // 1, but the rescue rule can promote a candidate
                            // the composite order put lower.
                            matchedRank: i + 1,
                        };

                        await appendToFile(outputFilePath, finalObj);
                        foundProductCount++;
                        break; // Break after finding the first match
                    }

                }


            } catch (error) {
                console.error("Error processing match data:", error);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: error.message
                });

                continue; // Skip to the next source product if there's an error
            }

            timing.logEvent(foundProductCount === 0 ? "Result: no candidate cleared the match threshold" : "Result: match found");

            recordProgress(
                projectId, destination, sourceProduct.sku,
                foundProductCount === 0 ? "no-match" : "matched",
                foundProductCount === 0 ? {
                    asin: sourceProduct.asin,
                    size: srcVariation.size,
                    colourToken: srcVariation.colourToken || undefined,
                    candidates: productBatches.length,
                    // The best composite reached, so a near-miss is visible in
                    // the ledger without opening the output files.
                    bestComposite: matchData[0] ? (matchData[0].composite_score ?? null) : null,
                } : {
                    asin: sourceProduct.asin,
                    size: srcVariation.size,
                    colourToken: srcVariation.colourToken || undefined,
                    candidates: productBatches.length,
                    matchedTitle: (matchedEntry && matchedEntry.product && matchedEntry.product.title) || "",
                    matchedUrl: (matchedEntry && matchedEntry.product && matchedEntry.product.url) || "",
                    composite: matchedEntry ? matchedEntry.composite_score : null,
                    matchRule: matchedEntry ? matchDecision(matchedEntry).rule : null,
                }
            );

            if (foundProductCount === 0) {
                console.log("No matching products found for:", sourceProduct.title);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No matching products found"
                });

                // A non-match still carries the BEST score that was achieved,
                // which is the number that explains the outcome: "nothing
                // matched" and "the best candidate reached 0.69 against a 0.70
                // gate" are very different findings, and the second is
                // invisible if only an empty object is written. matchData is
                // sorted best-first, so [0] is the best candidate.
                const best = matchData[0] || null;

                await appendToFile(outputFilePath, {
                    sourceProduct: sourceProduct,
                    sourceVariation: srcVariation,
                    matchedProducts: {},
                    modelScore: modelScoreOf(best),
                    bestCandidate: best && best.product ? {
                        title: best.product.title || "",
                        url: best.product.url || "",
                        sku: best.product.sku || "",
                        price: best.product.price ?? null,
                    } : null,
                    candidatesScored: matchData.length,
                });

            } else {
                console.log(`Found ${foundProductCount} matching products for:`, sourceProduct.title);
            }

        }
        const allProducts = fs.existsSync(outputFilePath) ? JSON.parse(fs.readFileSync(outputFilePath, "utf8")) : [];
        console.log("Total matched products:", allProducts.length);

        console.log("Product matching completed successfully.");

        timing.endRun(`${sourceProducts.length} SKU(s), ${allProducts.length} row(s) in the final output`);

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: REPORT_EMAIL,
            subject: `Product Matching Report for ${brand} - ${projectId} (${targetConfig.label})`,
            text: `Product matching against ${targetConfig.label} completed successfully for brand: ${brand} and projectId: ${projectId}. Total matched products: ${allProducts.length}`,
            attachments: [
                {
                    filename: 'products_matched_final.json',
                    path: fs.existsSync(outputFilePath) ? outputFilePath : emptyFilePath,
                },
                {
                    filename: 'products_matching_errors.json',
                    path: fs.existsSync(errorFilePath) ? errorFilePath : emptyFilePath,
                },
                {
                    filename: 'products_matched.json',
                    path: fs.existsSync(matchedFilePath) ? matchedFilePath : emptyFilePath,
                },
                {
                    filename: 'product_matching_timing.log',
                    path: timingFilePath,
                }
            ]
        };

        await sendUpdateReportEmail(mailOptions);

        // if (fs.existsSync(outputFilePath)) {
        //     fs.unlinkSync(outputFilePath);
        // }

        // if (fs.existsSync(errorFilePath)) {
        //     fs.unlinkSync(errorFilePath);
        // }

        // if (fs.existsSync(matchedFilePath)) {
        //     fs.unlinkSync(matchedFilePath);
        // }
        // }

        await closeFetchClients();


    } catch (err) {
        console.error("Error:", err);
        timing.endRun(`aborted: ${err.message}`);
        const mailOptions = {
            from: config.FROM_EMAIL,
            to: REPORT_EMAIL,
            subject: `Product Matching Error for ${brands.join(", ")} - ${projectId} (${destination})`,
            text: `An error occurred during product matching against ${destination} for brand: ${brands.join(", ")} and projectId: ${projectId}. Error: ${err.message}`,
        };

        await sendUpdateReportEmail(mailOptions);
    }
}

// ---------------------------------------------------------------------------
// New brand-driven flow: looks up every {target, direction} pair configured
// for `brandName` in config/brandTargets.js and runs all of them, combining
// results into one spreadsheet. This is what powers the Teknum x Amazon
// UAE / Firstcry UAE (forward + reverse) checks.
// ---------------------------------------------------------------------------
async function runBrandMatching(brandName, projectId, skus = null) {
    const targets = brandTargets[brandName];
    if (!targets || targets.length === 0) {
        throw new Error(`No target sites configured for brand "${brandName}" in config/brandTargets.js`);
    }

    // The brand's own catalog rows — used as the source list for "forward"
    // checks, and as the comparison pool for "reverse" checks. An optional
    // `skus` list narrows this to specific products (e.g. a 10-product test
    // run). It only selects WHICH of our own rows to process — the target
    // sites are still searched by product title, not by SKU (a Mumzworld SKU
    // means nothing on Amazon UAE / Firstcry UAE).
    const where = { brand: { [Op.iLike]: brandName }, projectId };
    if (Array.isArray(skus) && skus.length > 0) {
        where.sku = { [Op.in]: skus.map((s) => String(s)) };
    }

    const localCatalog = await ScratchProducts.findAll({
        where,
        raw: true,
        attributes: ['title', 'url', 'brand', 'sku', 'asin', 'category', 'images', 'attributes', 'price', 'mrp']
    });

    if (localCatalog.length === 0) {
        const skuNote = Array.isArray(skus) && skus.length > 0 ? ` and skus [${skus.join(", ")}]` : "";
        throw new Error(`No catalog rows found for brand "${brandName}" and projectId ${projectId}${skuNote}`);
    }

    const runId = Date.now();
    const errorFilePath = `brand_matching_errors_${brandName}_${projectId}_${runId}.json`;
    const matchedFilePath = `brand_matching_raw_${brandName}_${projectId}_${runId}.json`;
    const excelFilePath = `brand_matching_${brandName}_${projectId}_${runId}.xlsx`;
    const timingFilePath = timing.startRun(
        timing.timingLogPath(`brand_${brandName}_${projectId}_${runId}`),
        `brand matching for ${brandName}, project ${projectId}, ${localCatalog.length} SKU(s), ` +
        `targets: ${targets.map((t) => `${t.target}/${t.direction}`).join(", ")}`
    );
    const allResults = [];

    for (const { target: targetId, direction } of targets) {
        const targetConfig = targetSites[targetId];
        if (!targetConfig) {
            console.error(`Unknown target site "${targetId}" in brandTargets config, skipping.`);
            continue;
        }

        console.log(`Running ${direction} check for ${brandName} against ${targetConfig.label}`);

        if (direction === "forward") {
            // Same shape as the legacy flow: iterate our own catalog rows,
            // search the target for each one.
            for (let p = 0; p < localCatalog.length; p++) {
                const sourceProduct = localCatalog[p];
                timing.beginSku(sourceProduct.sku, `${targetConfig.label} ${direction}, ${p + 1}/${localCatalog.length}`);

                await delay(1500);

                const candidates = await timing.step(
                    `${targetConfig.label} candidate collection`,
                    () => buildCandidatesFromSearch(targetConfig, searchQueryFor(targetConfig, sourceProduct)),
                    { summarize: (c) => `${c.length} candidate(s)` }
                );
                if (candidates.length === 0) {
                    timing.logEvent(`Result: no products found on ${targetConfig.label}`);
                    await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct, error: "No products found" });
                    continue;
                }

                let matchData = [];
                try {
                    matchData = await callMatchingService(sourceProduct, candidates);
                } catch (err) {
                    await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct, error: err.message });
                    continue;
                }

                await appendToFile(matchedFilePath, { direction, target: targetConfig.label, sourceProduct, matchedProducts: matchData });

                const best = pickBestMatch(matchData);
                timing.logEvent(best ? "Result: match found" : "Result: no candidate cleared the match threshold");
                allResults.push({
                    targetLabel: targetConfig.label,
                    direction,
                    sourceProduct,
                    matched: !!best,
                    matchedProduct: best ? best.matchedProduct : null,
                    fieldScores: best ? best.fieldScores : null,
                });
            }
        }
        // Reverse direction disabled for now (out of scope per current HLD —
        // forward-only). Left in place, commented, rather than deleted:
        // else if (direction === "reverse") {
        //     // Search the target site for the brand itself, then check each
        //     // result found there against our own catalog. NOTE: this only
        //     // covers the first page of results the target returns for the
        //     // brand-name query — no pagination yet. Good enough to surface
        //     // "things listed under this brand that we don't have tracked,"
        //     // but not an exhaustive crawl of the target site.
        //     const targetSideProducts = await buildCandidatesFromSearch(targetConfig, brandName);
        //
        //     for (const targetSideProduct of targetSideProducts) {
        //         await delay(1500);
        //
        //         let matchData = [];
        //         try {
        //             matchData = await callMatchingService(targetSideProduct, localCatalog);
        //         } catch (err) {
        //             await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct: targetSideProduct, error: err.message });
        //             continue;
        //         }
        //
        //         await appendToFile(matchedFilePath, { direction, target: targetConfig.label, sourceProduct: targetSideProduct, matchedProducts: matchData });
        //
        //         const best = pickBestMatch(matchData);
        //         allResults.push({
        //             targetLabel: targetConfig.label,
        //             direction,
        //             sourceProduct: targetSideProduct,
        //             matched: !!best,
        //             matchedProduct: best ? best.matchedProduct : null,
        //             fieldScores: best ? best.fieldScores : null,
        //         });
        //     }
        // }
    }

    exportResultsToExcel(allResults, excelFilePath);

    const matchedCount = allResults.filter((r) => r.matched).length;

    timing.endRun(`${matchedCount}/${allResults.length} row(s) matched`);

    const mailOptions = {
        from: config.FROM_EMAIL,
        to: REPORT_EMAIL,
        subject: `Product Matching Report for ${brandName} - ${projectId}`,
        text: `Multi-marketplace product matching completed for brand: ${brandName}, project: ${projectId}. ${matchedCount}/${allResults.length} rows matched. See attached spreadsheet.`,
        attachments: [
            { filename: 'product_matching_results.xlsx', path: excelFilePath },
            { filename: 'product_matching_raw.json', path: fs.existsSync(matchedFilePath) ? matchedFilePath : `emptyFile.json` },
            { filename: 'product_matching_errors.json', path: fs.existsSync(errorFilePath) ? errorFilePath : `emptyFile.json` },
            { filename: 'product_matching_timing.log', path: timingFilePath },
        ]
    };

    await sendUpdateReportEmail(mailOptions);

    return { excelFilePath, totalRows: allResults.length, matchedCount };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const config = require("./config.json");
const { Op } = require('sequelize');

// Body: { brand: [<source SKUs>], projectId, category?, destination? }.
// `destination` is the marketplace searched for each source product — "nahdi"
// (default) or "mumzworld".
app.post('/product-matching', async (req, res) => {
    const { brand, projectId, category, destination = "nahdi" } = req.body;
    console.log(brand)
    if (!brand || brand.length == 0 || !projectId) {
        return res.status(400).json({ error: "Brand and projectId are required parameters." });
    }

    if (!MATCHING_DESTINATIONS.includes(destination)) {
        return res.status(400).json({ error: `destination must be one of: ${MATCHING_DESTINATIONS.join(", ")}.` });
    }

    try {

        res.status(200).json({ message: "Product matching started successfully." });

        await timing.withTimingContext(() => productMatching(brand, projectId, category, destination));

        console.log("Product matching completed successfully.");
    } catch (error) {
        console.error("Error in product matching:", error);

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: REPORT_EMAIL,
            subject: `Product Matching Error for ${brand} - ${projectId}`,
            text: `An error occurred during product matching for brand: ${brand} and projectId: ${projectId}. Error: ${error.message}`,
        };

        await sendUpdateReportEmail(mailOptions);

        res.status(500).json({ error: "An error occurred during product matching." });
    }
});

// New: config-driven, multi-target (+ reverse-check) matching for a whole
// brand, e.g. { "brandName": "Teknum", "projectId": 342 }. Which target
// sites and directions run is controlled entirely by config/brandTargets.js.
// Optionally pass "skus": ["...", "..."] to limit the run to specific products
// (e.g. a 10-product test); omit it to process the brand's whole catalog.
app.post('/product-matching/brand', async (req, res) => {
    const { brandName, projectId, skus } = req.body;

    if (!brandName || !projectId) {
        return res.status(400).json({ error: "brandName and projectId are required parameters." });
    }

    if (skus !== undefined && !Array.isArray(skus)) {
        return res.status(400).json({ error: "skus, if provided, must be an array of SKU strings." });
    }

    try {
        res.status(200).json({ message: "Brand product matching started successfully." });

        const result = await timing.withTimingContext(() => runBrandMatching(brandName, projectId, skus));

        console.log("Brand product matching completed successfully.", result);
    } catch (error) {
        console.error("Error in brand product matching:", error);

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: REPORT_EMAIL,
            subject: `Product Matching Error for ${brandName} - ${projectId}`,
            text: `An error occurred during brand product matching for brand: ${brandName} and projectId: ${projectId}. Error: ${error.message}`,
        };

        await sendUpdateReportEmail(mailOptions);
    }
});

app.get("/test", async (req, res) => {
    return res.status(200).json({ message: "API is working fine." });
});

const server = app.listen(8010, () => {
    console.log("Server is running on port 8010");
});

// Both fetch clients hold something open for the life of the process — the
// browser (helper/browserClient.js) and the keep-alive proxy tunnel
// (helper/httpClient.js) — so a Ctrl-C or a container stop would otherwise
// leave an orphaned Chrome and a dangling socket behind.
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        console.log(`Received ${signal}, shutting down...`);
        server.close();
        await closeFetchClients();
        process.exit(0);
    });
}
