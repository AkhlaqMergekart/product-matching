// Reading a project-360 Speedo source row: what to SEARCH on, and which
// VARIATION (size) the row is.
//
// Measured over all 313 Speedo rows of project 360 on 2026-11-16:
//
//   rows                               313
//   DISTINCT asin                      313   <- unique per row: the variation key
//   DISTINCT sku                       102
//   DISTINCT title                     102
//   asin startsWith sku                313   (100%)
//   asin contains a hyphen               0   <- NO separator, unlike the others
//   attributes / category / size          0   (all empty)
//   price / images                        0   (none at all for this brand)
//
// Row shape:
//
//   title : "<AUDIENCE-CODE> <GARMENT>" or a plain descriptive name
//   sku   : "<STYLECODE>"               e.g. 812411012, 8FS878014, 8061680001
//   asin  : "<STYLECODE><SIZE>"         e.g. 81241101224 = 812411012 + "24"
//
// Three things make this target different from Puma and Technosport:
//
// 1. THE STYLE CODE IS NOT SEARCHABLE. Technosport indexes its code as
//    masterProductCode, so the code alone was the ideal query. Speedo's
//    Shopify search returns ZERO results for "812411012" — verified for the
//    bare code and several truncations. But the code IS embedded in every
//    product handle:
//      boys-endurance10-medley-gala-logo-jammer-...-812411012
//    so it is the VERIFICATION key (did we find the right product?) rather
//    than the query. See styleCodeInHandle().
//
// 2. THE AUDIENCE IS AN ABBREVIATION the storefront spells out. The source
//    writes "JM MEDLEY JAMMER"; Speedo lists "Boy's Endurance10 Medley Gala
//    Logo Jammer". Searching the raw title MISSED that product entirely while
//    the expanded form found it at rank 6 — measured, not assumed:
//      "JM MEDLEY JAMMER"     -> 10 results, target MISSING
//      "Boy's MEDLEY JAMMER"  -> 10 results, target at rank 6
//    So the code is expanded before searching.
//
// 3. ONLY ~HALF THE CATALOGUE USES CODES. Of the 102 distinct titles, 51 lead
//    with an audience code (AM/AF/JM/JF/JR/SEA/JET/PRT) and 51 are plain
//    descriptive names ("Long Hair Cap - Black", "BIOFUSE 2.0 GRN"). The plain
//    ones already match the storefront's wording and must be left alone — the
//    cap title found its product at rank 1 untouched.

// Audience codes seen in the data, mapped to how Speedo's own listings word
// them. An empty string means "strip the token but add nothing": SEA/JET/PRT
// are product-line or attribute markers, not audiences, and inventing a word
// for them would only narrow the query.
// Only genuine AUDIENCE markers belong here. Everything else that happens to
// lead a title in capitals is part of the PRODUCT NAME and stripping it breaks
// the search — measured, not assumed:
//
//   "JET 2.0 GOG AU BLUE/GREY"
//     stripping JET -> "2.0 GOG AU BLUE/GREY"  -> target MISSING
//     keeping  JET -> "JET 2.0"                -> target at RANK 2
//
// JET, SEA (Sea Squad) and FUTURA are product LINES; PRT is an attribute
// ("printed"). They were in this map in the first draft and cost real hits.
const AUDIENCE_CODES = {
  AM: "Men's",
  AF: "Women's",
  JM: "Boy's",
  JF: "Girl's",
  JR: "Junior",
  JU: "Junior",
};

// Size tokens that appear as the asin suffix. Numeric chest/waist sizes
// (22-48) and letter sizes pass through unchanged; kids years are normalised
// from the zero-padded form the feed uses ("04Y" -> "4Y").
const LETTER_SIZES = new Set(["XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "XXXL"]);

const LEADING_BRAND_RE = /^speedo\s+/i;

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// Splits a source title into its parts.
//
// Returns { productName, audience, audienceCode } — `productName` is the
// title with the brand and the audience CODE removed, and `audience` is the
// spelled-out word to search with (possibly "").
function parseSpeedoTitle(title) {
  const raw = normalizeSpace(title).replace(LEADING_BRAND_RE, "");
  if (!raw) return { productName: "", audience: "", audienceCode: "" };

  // A leading 2-3 letter token, only when it is a KNOWN code. An unknown
  // all-caps token is part of the product name ("BIOFUSE", "KICK BOARD") and
  // stripping it would destroy the query.
  const match = /^([A-Z]{2,3})\s+/.exec(raw);
  if (match && Object.prototype.hasOwnProperty.call(AUDIENCE_CODES, match[1])) {
    return {
      productName: raw.slice(match[0].length).trim(),
      audience: AUDIENCE_CODES[match[1]],
      audienceCode: match[1],
    };
  }

  return { productName: raw, audience: "", audienceCode: "" };
}

// The variation: the size, taken from the asin's suffix after the sku.
//
// There is NO separator ("81241101224" = sku "812411012" + size "24"), so the
// sku is stripped by prefix — splitting on a delimiter is not an option here.
// 62 of the 313 rows have NO suffix at all: one-size items (caps, goggles,
// earplugs), for which `size` is correctly "".
function parseSpeedoAsin(asin, sku) {
  const a = normalizeSpace(asin).toUpperCase();
  const s = normalizeSpace(sku).toUpperCase();
  if (!a) return { size: "", sizeToken: "", styleCode: s, hasSize: false };

  const tail = s && a.startsWith(s) ? a.slice(s.length) : "";
  if (!tail) return { size: "", sizeToken: "", styleCode: s, hasSize: false };

  let size = tail;
  // "04Y" -> "4Y": the feed zero-pads single-digit ages, Speedo does not.
  const years = /^0?(\d{1,2})Y$/.exec(tail);
  if (years) size = years[1] + "Y";
  else if (LETTER_SIZES.has(tail)) size = tail;
  // Numeric sizes are left exactly as written (22, 24, ... 48).

  return { size, sizeToken: tail, styleCode: s, hasSize: true };
}

// PRIMARY query: the title with the brand removed and the audience code
// expanded to the word Speedo's own listings use.
//
// Per the brief this is "title + variation, brand removed". The variation
// (size) is deliberately NOT in the query: Shopify ANDs the search terms, so
// adding "24" to "Boy's MEDLEY JAMMER" would require the listing TITLE to
// contain "24" — which it never does, because size is a variant attribute
// rather than part of the product name. Including it returns zero results.
// The size is matched per-candidate afterwards instead, against the variant
// list on the product.
function buildSpeedoQuery(sourceProduct) {
  const { productName, audience } = parseSpeedoTitle(sourceProduct?.title);
  const query = [audience, productName].filter(Boolean).join(" ");
  return normalizeSpace(query) || normalizeSpace(sourceProduct?.title).replace(LEADING_BRAND_RE, "");
}

// FALLBACK query, used only when the primary found nothing usable.
//
// Shopify's search ANDs its terms, so a long source title fails whenever ONE
// of its words is absent from the listing's wording — the source says
// "JUNIOR HYDROSITY 2.0 PINK/BLUE" and gets 0 results, while "HYDROSITY 2.0"
// finds the product at rank 4. So this drops the colour tail after " - " and
// keeps the leading few words, which are the model name.
function buildSpeedoFallbackQuery(sourceProduct) {
  const { productName, audience } = parseSpeedoTitle(sourceProduct?.title);

  // Colour lives after " - " or "," on the descriptive titles ("Long Hair Cap
  // - Blue & Purple", "FUTURA CLASSIC, GREEN/CLEAR") and is the part most
  // likely to differ from the listing's wording.
  let s = String(productName || "").split(" - ")[0].split(",")[0];

  // Drop the feed's trailing abbreviation noise, which never appears in a
  // storefront title: "GOG" (goggle), "AU" (adult unisex), a "X/Y" colour
  // pair, and a bare trailing colour word.
  s = s.replace(/\b(GOG|GOGGLE|AU|JU|WS|SS)\b/gi, " ")
       .replace(/\b[A-Z]+\/[A-Z]+\b/gi, " ")
       .replace(/\s+/g, " ")
       .trim();

  // Keep the leading words — the model name. Two is what recovered JET 2.0
  // ("JET 2.0" -> rank 2) where the full title returned nothing; three is
  // still safe for longer model names. Shopify ANDs the terms, so every extra
  // word is another chance to miss.
  const head = s.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");

  const query = [audience, head].filter(Boolean).join(" ");
  return normalizeSpace(query);
}

// Is this candidate the source row's product?
//
// Speedo's handles end with the style code
// ("...-medley-gala-logo-jammer-dark-teal-812411012"), which makes identity
// PROVABLE rather than estimated — the same role Technosport's
// masterProductCode plays, just carried in the URL instead of a field.
//
// Compared case-insensitively on the handle AND the url, since the url carries
// query parameters that the handle does not.
function styleCodeInHandle(styleCode, candidate) {
  const code = normalizeSpace(styleCode).toUpperCase();
  if (!code) return false;
  const hay = `${candidate?.handle || ""} ${candidate?.url || ""}`.toUpperCase();
  return hay.includes(code);
}

module.exports = {
  parseSpeedoTitle,
  parseSpeedoAsin,
  buildSpeedoQuery,
  buildSpeedoFallbackQuery,
  styleCodeInHandle,
  AUDIENCE_CODES,
};
