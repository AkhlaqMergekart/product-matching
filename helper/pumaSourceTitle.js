// Splitting a project-360 Puma source title into the parts the Puma storefront
// needs: the product name to SEARCH on, and the VARIATION (colourway, size,
// audience) to pick the right tile out of the results.
//
// Why this exists at all, rather than reusing helper/variationMatch.js:
// project 353's rows carry their variation in an `attributes` blob ("Size",
// "Colour Name", "Variation Theme"). Project 360's Puma rows do NOT —
// `attributes` is null on all 810 of them, as are `category`, `price`, `mrp`
// and `images`. The only populated fields are sku, title and brand, so the
// variation has to be read out of the title.
//
// The titles are machine-generated and highly regular. Measured over all 810
// Puma rows of project 360 on 2026-11-16:
//
//   "PUMA <product name> - <audience> - <colourway>"            698 rows (3 segments)
//   "PUMA <product name> - <audience> - <colourway> - Size <n>"  99 rows (4 segments)
//   "PUMA <product name> - <colourway>"                          13 rows (2 segments, accessories)
//
//   segment[1] is one of Adult / Men's / Women's / Kids          788 rows (97.3%)
//   last segment is "Size <n>"                                    90 rows
//
// So: split on " - ", drop a leading "PUMA", treat a known audience word in
// the second slot as the audience, a trailing "Size n" as the size, and the
// remainder as the colourway. The 22 rows (2.7%) whose second segment is not a
// known audience are accessories ("PUMA FERRARI BB Cap - Rosso Corsa") and one
// product whose own name contains " - " ("PUMA Velocity NITRO 5 - PUMA x HYROX
// Shoes - Adult - ..."); both are handled by anchoring on the audience and the
// Size suffix rather than on segment position.

// The audience words seen in project 360, plus the obvious siblings that the
// same generator would produce for other catalogues. Matched whole-segment.
const AUDIENCE_WORDS = [
  "Adult", "Adults", "Men's", "Mens", "Men", "Women's", "Womens", "Women",
  "Kids", "Kid's", "Unisex", "Junior", "Juniors", "Infant", "Infants",
  "Boys", "Boy's", "Girls", "Girl's", "Baby", "Teen", "Teens", "Youth",
];

const AUDIENCE_RE = new RegExp(
  `^(?:${AUDIENCE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
  "i",
);

// "Size 128", "Size 9.5", "Size UK 7", "Size XL".
const SIZE_SEGMENT_RE = /^Size\s+(.+)$/i;

// Leading brand token. The titles all open with "PUMA " (810/810), which must
// come off before searching: in.puma.com is the brand's own site, so every hit
// is already Puma and the token only dilutes relevance ranking.
const LEADING_BRAND_RE = /^PUMA\s+/i;

// Puma writes its own trademarks in the product name ("Velocity NITRO™ 4",
// "NITROFOAM™"), and the source titles do not carry them. Stripping the symbol
// on both sides is what lets "Velocity NITRO 4 Shoes" line up with
// "Velocity NITRO™ 4 Women's Running Shoes".
function stripTrademarks(value) {
  return String(value || "").replace(/[™®©]/g, "").replace(/\s+/g, " ").trim();
}

// Parses a source title into its parts.
//
// Returns { productName, audience, colourway, size, segments } where every
// field is a (possibly empty) string. `productName` is what to search on:
// brand token removed, audience/colourway/size segments removed.
function parsePumaSourceTitle(title) {
  const raw = stripTrademarks(title);
  const segments = raw.split(" - ").map((s) => s.trim()).filter(Boolean);

  if (segments.length === 0) {
    return { productName: "", audience: "", colourway: "", size: "", segments: [] };
  }

  const parts = segments.slice();

  // A trailing "Size <n>" is unambiguous: take it off the end first.
  let size = "";
  const lastSize = parts.length > 1 ? SIZE_SEGMENT_RE.exec(parts[parts.length - 1]) : null;
  if (lastSize) {
    size = lastSize[1].trim();
    parts.pop();
  }

  // The audience segment anchors the split between name and colourway: on this
  // generator's output everything before it is the product name and everything
  // after it is the colourway. Searched from the left but never at index 0,
  // where the product name lives.
  let audience = "";
  let audienceAt = -1;
  for (let i = 1; i < parts.length; i++) {
    if (AUDIENCE_RE.test(parts[i])) { audience = parts[i]; audienceAt = i; break; }
  }

  let nameParts;
  let colourway;

  if (audienceAt !== -1) {
    // "PUMA Velocity NITRO 5 - PUMA x HYROX Shoes - Adult - Intense Mint" ->
    // name "Velocity NITRO 5 - PUMA x HYROX Shoes", colour "Intense Mint".
    nameParts = parts.slice(0, audienceAt);
    colourway = parts.slice(audienceAt + 1).join(" - ");
  } else if (parts.length >= 2) {
    // No audience segment (accessories): the LAST segment is the colourway and
    // everything before it is the name. "PUMA FERRARI BB Cap - Rosso Corsa".
    nameParts = parts.slice(0, parts.length - 1);
    colourway = parts[parts.length - 1];
  } else {
    // A single segment: all name, no variation to speak of.
    nameParts = parts.slice();
    colourway = "";
  }

  // Some rows carry a trailing style code in the colourway
  // ("Green Lux (02730702)"); it is not a colour word and would never appear
  // in Puma's own colorName.
  colourway = String(colourway || "").replace(/\s*\([0-9]{5,}\)\s*$/, "").trim();

  const productName = nameParts.join(" - ").replace(LEADING_BRAND_RE, "").trim();

  return { productName, audience, colourway, size, segments };
}

// The query sent to in.puma.com/in/en/search?q=...
//
// Per the brief: title + variation, with the brand name removed because the
// search runs on Puma's own site. "Variation" here is the colourway — the
// thing that distinguishes one tile from another in the results, since Puma
// returns ONE TILE PER COLOURWAY. The audience is included because it is part
// of how Puma names its products ("Women's Running Shoes") and sharpens the
// gender split; the size is NOT, because sizes are not indexed as search terms
// and "Size 128" only adds noise.
function buildPumaQuery(sourceProduct) {
  const { productName, audience, colourway } = parsePumaSourceTitle(sourceProduct?.title);

  const parts = [productName, audience, colourway].filter((p) => p && p.trim());
  const query = parts.join(" ").replace(/\s+/g, " ").trim();

  // Fall back to the bare title (brand stripped) rather than returning empty,
  // which would search for nothing and report a false "no products found".
  if (query) return query;
  return stripTrademarks(sourceProduct?.title).replace(LEADING_BRAND_RE, "").trim();
}

// A narrower query for the retry pass: product name + audience only, no
// colourway. Puma's search is strict enough that a colour it does not
// recognise ("Alpine Snow") can return zero hits for a product that is very
// much on the site, so dropping the colour and matching it per-tile instead
// recovers those.
function buildPumaQueryWithoutColour(sourceProduct) {
  const { productName, audience } = parsePumaSourceTitle(sourceProduct?.title);
  const query = [productName, audience].filter((p) => p && p.trim()).join(" ").replace(/\s+/g, " ").trim();
  if (query) return query;
  return stripTrademarks(sourceProduct?.title).replace(LEADING_BRAND_RE, "").trim();
}

// The row's SIZE, which on this project lives in `asin` rather than in the
// title or the `size` column.
//
// Project 360 holds one row per size, and the rows of a given product are
// otherwise byte-identical — same title, same colourway, same price. Measured
// over all 810 Puma rows on 2026-11-16:
//
//   rows                              810
//   DISTINCT asin                     810   <- unique per row: the variation key
//   DISTINCT sku                      275
//   DISTINCT title                    275   <- title does NOT distinguish them
//   `size` column populated             0   <- empty on every row
//   asin matching "<sku>-<suffix>"    797   (98.4%)
//
// The suffix is the size: S / M / L / XL / XXL for apparel, 4-11 for footwear,
// 128-176 for kids. So `asin` is the only field that tells one variation row
// from another, and without reading it all 7 size-rows of a shoe would produce
// an identical query and an indistinguishable output row.
//
// Returns "" when the asin carries no suffix (13 rows, where asin is the bare
// sku), which correctly means "no size for this product" — accessories.
function sourceSizeFromAsin(sourceProduct) {
  const asin = String(sourceProduct?.asin ?? "").trim();
  const sku = String(sourceProduct?.sku ?? "").trim();
  if (!asin) return "";

  // Prefer stripping the row's own sku prefix: a sku can itself contain a
  // hyphen ("63702187-128"), so splitting on the first hyphen would cut the
  // sku rather than isolate the size.
  if (sku && asin.startsWith(sku + "-")) {
    return asin.slice(sku.length + 1).trim();
  }

  // Fall back to the last hyphen-separated segment, but only when it looks
  // like a size — a bare numeric sku must not be read as a size.
  const idx = asin.lastIndexOf("-");
  if (idx === -1) return "";
  const tail = asin.slice(idx + 1).trim();
  return /^(?:[0-9]{1,3}(?:\.[05])?|X{0,3}[SLM]|XX?L|XS|S|M|L)$/i.test(tail) ? tail : "";
}

module.exports = {
  parsePumaSourceTitle,
  buildPumaQuery,
  buildPumaQueryWithoutColour,
  sourceSizeFromAsin,
  stripTrademarks,
  AUDIENCE_RE,
};
