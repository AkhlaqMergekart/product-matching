// Reading a project-360 New Balance source row: what to SEARCH on, and which
// VARIATION (width + size) the row is.
//
// Measured over all 183 New Balance rows of project 360 on 2026-11-17:
//
//   rows                               183
//   DISTINCT asin                      183   <- unique per row: the variation key
//   DISTINCT sku                        38
//   DISTINCT title                       38
//   asin has exactly 3 hyphen parts    183   (100%)  "<STYLE>-<MID>-<SIZE>"
//   `attributes` populated             183   <- FIRST target here with real attributes
//   `category` populated               183   ("Men's Footwear > Sneakers")
//   `price` populated                  183   <- and it is a real number, not "Not Found"
//   `images`                             0
//   titles containing "New Balance"     93   (51%)
//
// Three things distinguish this feed from Puma / Technosport / Speedo:
//
// 1. THE ASIN IS "<STYLE>-<MID>-<SIZE>" ON EVERY ROW, but `sku` relates to it
//    DIFFERENTLY for footwear and apparel:
//
//      footwear: sku "U200017F"    asin "U200017F-D-7.5"   -> sku == STYLE, MID is the WIDTH (D/B)
//      apparel : sku "MP53504ABJ"  asin "MP53504-ABJ-S"     -> sku == STYLE+MID concatenated, MID is the COLOUR
//
//    `asin.startsWith(sku)` is therefore true on only 106 of 183 rows, and
//    `style+mid === sku` on only 77 — neither rule works alone. What IS
//    uniform: split on "-", the LAST segment is the size. That is the rule
//    used here. (`attributes.variant_seller_sku` equals `asin` on all 183
//    rows, and `attributes.SKU` equals the `sku` column on all 183, so the
//    attribute blob confirms rather than extends what the columns say.)
//
// 2. ONLY HALF THE TITLES CARRY THE BRAND (93/183). The ones that do start
//    with it ("New Balance Men Ellipse Running Shoe Beige"); the rest are bare
//    ("Men 530 Casual Shoe - Black", "Ramen T-Shirt"). So the brand strip is
//    conditional, not a fixed prefix removal — and it must not damage a title
//    that never had it.
//
// 3. `attributes.gender` and `category` are populated, which no previous target
//    in this project had. They sharpen the query where the title is generic:
//    "Ramen T-Shirt" says nothing about who it is for, while the category says
//    "Men's Apparel > Topwear".

// The brand as the feed writes it, anywhere in the title (not only leading).
const BRAND_RE = /\bnew\s*balance\b/gi;

// Size tokens seen in the data: half-sizes for footwear (4.5-12.5), letter
// sizes for apparel (XS-2XL, sometimes lower-cased in the feed).
const LETTER_SIZES = new Set(["XS", "S", "M", "L", "XL", "2XL", "3XL", "XXL", "XXXL"]);

// Footwear widths. These are the MID segment for footwear and must never be
// mistaken for a colour code.
const WIDTHS = new Set(["B", "D", "2E", "4E", "6E", "EE", "EEEE"]);

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// Strips the brand wherever it appears, and tidies the punctuation that
// stripping can leave behind ("New Balance Men ..." -> "Men ...", and a title
// that was ONLY the brand collapses to "").
function stripBrand(title) {
  return normalizeSpace(
    String(title || "")
      .replace(BRAND_RE, " ")
      // a leading/trailing dash left by the removal
      .replace(/^\s*[-–—]\s*/, "")
      .replace(/\s*[-–—]\s*$/, ""),
  );
}

// The variation: width (or colour code) and size, from the asin.
//
// The asin is "<STYLE>-<MID>-<SIZE>" on all 183 rows. Split from the RIGHT so
// a style code containing a hyphen cannot shift the size: the last segment is
// always the size, the one before it the width/colour.
function parseNewBalanceAsin(asin, sku) {
  const raw = normalizeSpace(asin);
  if (!raw) return { size: "", width: "", colourCode: "", styleCode: normalizeSpace(sku), hasSize: false };

  const seg = raw.split("-");
  if (seg.length < 2) {
    return { size: "", width: "", colourCode: "", styleCode: raw, hasSize: false };
  }

  const size = seg[seg.length - 1].trim();
  const mid = seg.length >= 3 ? seg[seg.length - 2].trim() : "";
  const style = seg.slice(0, Math.max(1, seg.length - 2)).join("-").trim();

  // A single letter/width token is a FOOTWEAR WIDTH; anything longer is an
  // apparel COLOUR code ("ABJ", "DNT", "BOY"). Distinguished because the two
  // mean different things and should not be reported in one field.
  const midUpper = mid.toUpperCase();
  const isWidth = WIDTHS.has(midUpper);

  return {
    // Normalised to upper case: the feed has both "XL" and "xl", "2XL" and "2xl".
    size: LETTER_SIZES.has(size.toUpperCase()) ? size.toUpperCase() : size,
    width: isWidth ? midUpper : "",
    colourCode: isWidth ? "" : midUpper,
    styleCode: style,
    hasSize: Boolean(size),
  };
}

// Reads a value out of the attributes blob, which is an ARRAY of one object on
// every row of this project.
function attr(sourceProduct, key) {
  const a = Array.isArray(sourceProduct?.attributes)
    ? sourceProduct.attributes[0] || {}
    : sourceProduct?.attributes || {};
  const v = a?.[key];
  return v == null ? "" : normalizeSpace(v);
}

// The audience word, from `attributes.gender` or the `category` path.
//
// Used only to sharpen a generic title: the feed's apparel titles are often
// just the graphic's name ("Ramen T-Shirt", "Grab a Bite Tokyo T-Shirt"), which
// on a brand site returns every colourway for every gender.
function audienceOf(sourceProduct) {
  const gender = attr(sourceProduct, "gender").toLowerCase();
  if (gender === "male") return "Men";
  if (gender === "female") return "Women";
  if (gender === "unisex") return "";

  const cat = String(sourceProduct?.category || "");
  if (/^men/i.test(cat)) return "Men";
  if (/^women/i.test(cat)) return "Women";
  return "";
}

// PRIMARY query: the title with the brand removed.
//
// Per the brief this is "title + variation, brand removed". The SIZE and WIDTH
// are deliberately NOT in the query: newbalance.com's search matches product
// names, and size/width are variant attributes that never appear in a product
// title — adding "7.5" or "D" would only narrow the result set to nothing.
// They are matched per-candidate afterwards instead.
//
// The audience is appended only when the title does not already imply it, so
// "Men 530 Casual Shoe" is not searched as "Men 530 Casual Shoe Men".
function buildNewBalanceQuery(sourceProduct) {
  const title = stripBrand(sourceProduct?.title);
  if (!title) return normalizeSpace(sourceProduct?.title);

  const audience = audienceOf(sourceProduct);

  // Do not add an audience the title already states, and never add one to a
  // title that says UNISEX. `attributes.gender` is "Male" even on the unisex
  // shoes ("Unisex ABZORB 2000 Casual Shoe"), so trusting gender alone
  // produced "Men Unisex ABZORB 2000 Casual Shoe" — a query that contradicts
  // itself and would match nothing on a site that indexes the word "unisex".
  const titleStatesAudience = /\b(men|women|unisex|kids?|boys?|girls?)('s)?\b/i.test(title);

  return normalizeSpace(!audience || titleStatesAudience ? title : `${audience} ${title}`);
}

// FALLBACK query, used only when the primary found nothing usable.
//
// Drops the colour tail after " - " ("Men 530 Casual Shoe - Black" -> "Men 530
// Casual Shoe") and keeps the leading words. A storefront's own product name
// routinely words the colour differently from the feed, and on a search that
// ANDs its terms one unmatched word returns zero results.
function buildNewBalanceFallbackQuery(sourceProduct) {
  let title = stripBrand(sourceProduct?.title).split(" - ")[0];

  // Drop the feed's own descriptive padding. Algolia ANDs the query terms, so
  // every word that is not in New Balance's own product NAME costs a hit — and
  // this feed adds several that never appear there. Measured against the live
  // index:
  //
  //   "Women AC Runner Running Shoe"   -> 0 hits
  //   "AC Runner"                      -> 9 hits (MACR18PU, WACR11F1, WACR15JI)
  //   "Women Trackside Relaxed T-Shirt"-> 0 hits
  //   "Trackside Relaxed"              -> 10 hits
  //
  // The audience word, the garment type ("Running Shoe", "T-Shirt", "Casual
  // Shoe") and the colour are all feed-side additions; the MODEL NAME is what
  // the index holds.
  title = title
    .replace(/\b(men|women|mens|womens|unisex|kids?|boys?|girls?)('s)?\b/gi, " ")
    .replace(/\b(running|casual|walking|training|lifestyle)?\s*(shoes?|sneakers?|trainers?)\b/gi, " ")
    .replace(/\b(t[-\s]?shirt|tee|hoodie|jogger|pant|short|jacket|sweatshirt|top|tank|legging|crop)s?\b/gi, " ")
    .replace(/\bfor\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Two or three words of model name is what matched on the live index; more
  // than that and the AND starts failing again.
  const head = title.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
  return normalizeSpace(head) || stripBrand(sourceProduct?.title);
}

// The style code on its own — the PRIMARY query for this target.
//
// New Balance indexes its own code: "MELPS87T" returns that exact styleID.
// This is the opposite of Speedo, whose code is unsearchable, and it matters
// because this feed's apparel titles are graphic names ("Ramen T-Shirt") that
// return hundreds of unrelated hits.
//
// The code comes from the asin's style segment rather than the `sku` column,
// because for apparel the sku concatenates style+colour ("MP53504ABJ") while
// the index holds them separately ("MP53504").
function buildNewBalanceCodeQuery(sourceProduct) {
  const v = parseNewBalanceAsin(sourceProduct?.asin, sourceProduct?.sku);
  return v.styleCode || normalizeSpace(sourceProduct?.sku);
}

// Is this candidate the source row's product?
//
// The style code is New Balance's own product id and appears in its product
// URLs and ids ("/pd/.../MR530SD", data-pid="MR530SD"), so a candidate whose
// id or url carries the style code is the same product beyond doubt — the same
// role the handle plays for Speedo.
function styleCodeMatches(styleCode, candidate) {
  const code = normalizeSpace(styleCode).toUpperCase();
  if (!code) return false;
  const hay = [candidate?.sku, candidate?.styleCode, candidate?.url, candidate?.handle]
    .map((v) => String(v || "").toUpperCase())
    .join(" ");
  return hay.includes(code);
}

module.exports = {
  parseNewBalanceAsin,
  buildNewBalanceQuery,
  buildNewBalanceCodeQuery,
  buildNewBalanceFallbackQuery,
  styleCodeMatches,
  stripBrand,
  audienceOf,
  WIDTHS,
};
