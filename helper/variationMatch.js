// Matching a source product's VARIATION (its size / colour) against the
// variants a destination product offers.
//
// Why this is a separate step from product matching: a ScratchProducts row is
// usually one child SKU — "SHREY INTENSE COMPRESSION LONG SLEEVE TOP" in size
// 2XL, navy — while a Myntra or Nykaa Fashion product page is the PARENT,
// carrying every size and linking out to every colour. Comparing the two at
// product level gives the parent's headline price, which can be the price of
// a different size or a different colour entirely.
//
// Best effort by design: when no variant lines up, the caller keeps the
// product-level data it already had rather than discarding the match.

// Project 353's attribute blobs use several spellings for the same idea
// (apparel carries "Size", footwear carries "Size (UK)" / "Size (US)" /
// "Euro Size" / "Foot Size"), so each concept is looked up through a list of
// candidate keys rather than one hardcoded name.
const SIZE_KEYS = ["Size", "Size (UK)", "Size (US)", "Euro Size", "Foot Size"];
const COLOUR_KEYS = ["Colour Name", "Colour Family", "Color Name", "Color Family"];

function firstValue(attrs, keys) {
  for (const key of keys) {
    const value = attrs?.[key];
    if (value != null && String(value).trim() && String(value).trim().toUpperCase() !== "NA") {
      return String(value).trim();
    }
  }
  return "";
}

// Reads the variation off a ScratchProducts row. `attributes` is an array —
// always length 1 across project 353's 2852 rows, but indexed defensively.
function sourceVariation(sourceProduct) {
  const attrs = Array.isArray(sourceProduct?.attributes) ? sourceProduct.attributes[0] || {} : sourceProduct?.attributes || {};

  return {
    size: firstValue(attrs, ["Size"]),
    sizeUk: firstValue(attrs, ["Size (UK)"]),
    sizeUs: firstValue(attrs, ["Size (US)"]),
    euroSize: firstValue(attrs, ["Euro Size"]),
    anySize: firstValue(attrs, SIZE_KEYS),
    colour: firstValue(attrs, COLOUR_KEYS),
    // "Colour, Size" | "Size" | "Colour" | "Standalone". When absent, the
    // presence of a size or colour value is the fallback signal.
    theme: firstValue(attrs, ["Variation Theme"]),
    parentSku: firstValue(attrs, ["Parent SKU"]),
  };
}

// Canonical form for comparing size labels across two catalogues that write
// them differently. "2XL" and "XXL" are the same size; so are "UK 6 (EU 40)",
// "UK6" and "6" once the scale prefix is stripped.
function normalizeSize(value) {
  let s = String(value || "")
    .toUpperCase()
    .replace(/\(.*?\)/g, " ")   // drop parenthetical scales: "UK 6 (EU 40)" -> "UK 6"
    .replace(/\b(UK|US|EU|EURO|IND|IN)\b/g, " ")
    .replace(/\bSIZE\b/g, " ")
    .replace(/[^A-Z0-9.]/g, "");

  // 2XL <-> XXL, 3XL <-> XXXL, and so on in both directions.
  const nx = s.match(/^([2-6])X([SL])$/);
  if (nx) s = "X".repeat(Number(nx[1])) + nx[2];
  const xs = s.match(/^(X{2,6})([SL])$/);
  if (xs) s = xs[1] + xs[2];

  // Trailing ".0" on numeric sizes ("9.0" vs "9").
  if (/^\d+\.0$/.test(s)) s = s.replace(/\.0$/, "");

  return s;
}

function sizesMatch(a, b) {
  const x = normalizeSize(a);
  const y = normalizeSize(b);
  return Boolean(x && y && x === y);
}

// Colours are compared on words, not whole strings: a source colour is often
// compound ("WHITE/DIRECTOIRE BLUE", "Black / White") while a destination
// label is a single word ("White"). A shared significant colour word is the
// most that can honestly be claimed.
const COLOUR_STOPWORDS = new Set(["AND", "WITH", "THE", "COLOR", "COLOUR", "MULTI", "NA"]);

function colourTokens(value) {
  return String(value || "")
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((w) => w.length > 2 && !COLOUR_STOPWORDS.has(w));
}

function coloursMatch(a, b) {
  const x = colourTokens(a);
  const y = colourTokens(b);
  if (x.length === 0 || y.length === 0) return false;
  return x.some((w) => y.includes(w));
}

// Picks the destination variant that corresponds to `variation`.
//
// `detail.variants` is the per-size list the matchedDetail extractors build,
// each entry carrying its OWN price — which is the point of the exercise, as
// a parent's headline price need not be the price of the size we hold.
//
// Returns null when nothing lines up, which the caller treats as "keep the
// product-level data as it is".
function matchVariant(variation, detail) {
  const variants = Array.isArray(detail?.variants) ? detail.variants : [];
  if (variants.length === 0) return null;

  const wantSize = variation.anySize;
  if (!wantSize) {
    // Nothing to match on. A single-variant product (One Size) is still a
    // meaningful answer — there is only one thing it could be.
    return variants.length === 1 ? { variant: variants[0], matchedOn: ["only-variant"] } : null;
  }

  // Try each of the source's size spellings; footwear rows carry UK, US and
  // EU values for the same shoe and the destination may list any one of them.
  for (const [label, value] of [["size", variation.size], ["uk", variation.sizeUk], ["us", variation.sizeUs], ["eu", variation.euroSize]]) {
    if (!value) continue;
    const hit = variants.find((v) => sizesMatch(v.size, value));
    if (hit) return { variant: hit, matchedOn: [`size:${label}`] };
  }

  return null;
}

module.exports = {
  sourceVariation,
  normalizeSize,
  sizesMatch,
  coloursMatch,
  colourTokens,
  matchVariant,
};
