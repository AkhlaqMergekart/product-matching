// Reading a project-360 Technosport source row: what to SEARCH on, and which
// VARIATION (colour + size) the row actually is.
//
// Why this is separate from helper/pumaSourceTitle.js: the two feeds encode the
// same ideas differently, and the Technosport one is the richer of the two.
// Measured over all 433 Technosport rows of project 360 on 2026-11-16:
//
//   rows                               433
//   DISTINCT asin                      433   <- unique per row: the variation key
//   DISTINCT sku                        52
//   DISTINCT title                       52
//   asin shaped "<sku>-<colour>-<size>" 433   (100%)
//   asin[0] === sku                     433   (100%)
//   title ends with the sku code         52/52
//   title starts with "Technosport"      52/52
//   `attributes` / `category` / `size`     0   (all empty)
//   `price` / `images`                     0   (price is the string "Not Found")
//
// So the row shape is exactly:
//
//   title : "Technosport <audience>'s <garment> <STYLECODE>"
//   sku   : "<STYLECODE>"                      e.g. W156
//   asin  : "<STYLECODE>-<COLOUR>-<SIZE>"      e.g. W156-CF-MED, B242-LGB-12Y
//
// Two things follow, and they drive the whole target:
//
// 1. The STYLE CODE is the query. It is Technosport's own internal code, and
//    their search engine indexes it as `masterProductCode`. Searching "W156"
//    returned 8 results, ALL of them W156 (its eight colourways) — verified
//    across all 52 codes: 50 return only on-code results, 0 return a mix, and
//    2 (B228, B231) are delisted and return nothing at all.
//    That is a far better query than the title, which is generic
//    ("Boys' Track Pant") and returns 65+ unrelated products.
//
// 2. The colour lives ONLY in the asin, abbreviated (BS, NB, WG, CF) and
//    sometimes spelled out (BLACK, TEAL). The destination reports full colour
//    names ("Chili Flakes", "Midnight Blue"), so the two are matched on the
//    abbreviation's letters rather than by lookup table — see colourMatches().

// Size tokens seen in the data, mapped to the destination's own labels.
// Technosport's search returns `availablesize: ["S","M","L","XL","2XL"]`, so
// the source's three-letter forms have to be folded onto those.
const SIZE_ALIASES = {
  SML: "S", MED: "M", LAR: "L", XLR: "XL",
  "2XL": "2XL", "3XL": "3XL", XXL: "2XL",
  // Kids are stated in years on both sides ("08Y" -> "8Y").
  "08Y": "8Y", "10Y": "10Y", "12Y": "12Y", "14Y": "14Y", "16Y": "16Y",
};

// The leading brand token. All 52 titles begin with it, and it must come off:
// technosport.in is the brand's own site, so every hit is already Technosport
// and the word only dilutes the query.
const LEADING_BRAND_RE = /^technosport\s+/i;

// "Men's" / "Women's" / "Boys'" / "Girls'" as written in these titles.
const AUDIENCE_RE = /\b(Men's|Mens|Men|Women's|Womens|Women|Boys'|Boys|Boy's|Girls'|Girls|Girl's|Kids'|Kids|Unisex)\b/i;

// A Technosport style code: 1-2 letters then 2-3 digits ("W156", "OR219",
// "PL81", "BR15", "B242", "PM86", "WL20"). Anchored so it only matches a whole
// token, which is what keeps it from firing on a size or a colour.
const STYLE_CODE_RE = /^[A-Z]{1,2}[A-Z]?\d{2,3}$/;

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// Splits a source title into its parts.
//
// Returns { productName, audience, styleCode, garment } — all strings,
// possibly empty. `styleCode` is the trailing code and the thing worth
// searching; `garment` is the descriptive middle ("Half Sleeve Crew Neck
// T-Shirt") kept for the fallback query.
function parseTechnosportTitle(title, sku) {
  const raw = normalizeSpace(title);
  if (!raw) return { productName: "", audience: "", styleCode: "", garment: "" };

  let rest = raw.replace(LEADING_BRAND_RE, "").trim();

  // The trailing style code. Prefer the row's own sku — it IS the code on all
  // 433 rows, so this is exact rather than inferred — and fall back to the
  // pattern for a row whose sku is missing.
  let styleCode = "";
  const skuToken = normalizeSpace(sku).toUpperCase();
  if (skuToken && rest.toUpperCase().endsWith(" " + skuToken)) {
    styleCode = skuToken;
    rest = rest.slice(0, rest.length - skuToken.length - 1).trim();
  } else {
    const parts = rest.split(" ");
    const last = (parts[parts.length - 1] || "").toUpperCase();
    if (STYLE_CODE_RE.test(last)) {
      styleCode = last;
      parts.pop();
      rest = parts.join(" ").trim();
    }
  }

  // The audience, which the destination also states ("Women Printed Regular
  // Fit...") and which sharpens the fallback query's gender split.
  const audMatch = AUDIENCE_RE.exec(rest);
  const audience = audMatch ? audMatch[1] : "";
  const garment = audMatch
    ? normalizeSpace(rest.slice(0, audMatch.index) + " " + rest.slice(audMatch.index + audMatch[1].length))
    : rest;

  return { productName: rest, audience, styleCode, garment };
}

// The variation this row is: colour token and size, read off the asin.
//
// `asin` is "<sku>-<COLOUR>-<SIZE>" on all 433 rows. The sku is stripped by
// prefix rather than by splitting on the first hyphen, because a style code
// could itself contain one.
function parseTechnosportAsin(asin, sku) {
  const raw = normalizeSpace(asin).toUpperCase();
  const skuToken = normalizeSpace(sku).toUpperCase();
  if (!raw) return { colourToken: "", sizeToken: "", size: "", styleCode: skuToken };

  let tail = raw;
  if (skuToken && raw.startsWith(skuToken + "-")) {
    tail = raw.slice(skuToken.length + 1);
  } else {
    // No sku prefix: drop the first segment and hope it was the code.
    const idx = raw.indexOf("-");
    tail = idx === -1 ? "" : raw.slice(idx + 1);
  }

  if (!tail) return { colourToken: "", sizeToken: "", size: "", styleCode: skuToken };

  // The LAST segment is the size; everything before it is the colour (a colour
  // token can itself contain a hyphen).
  const segs = tail.split("-");
  const sizeToken = segs.length > 1 ? segs[segs.length - 1] : "";
  const colourToken = segs.length > 1 ? segs.slice(0, -1).join("-") : segs[0];

  return {
    colourToken,
    sizeToken,
    // Folded onto the destination's own label where known; otherwise the raw
    // token, which is already right for waist sizes ("30", "32").
    size: SIZE_ALIASES[sizeToken] || sizeToken,
    styleCode: skuToken,
  };
}

// PRIMARY query: the style code alone.
//
// Deliberately NOT title + variation text. Technosport indexes the code as
// `masterProductCode`, so the code returns exactly that product's colourways
// and nothing else (verified: 50 of 52 codes return only on-code results, with
// zero cross-product noise), whereas the title is generic and returns dozens
// of unrelated garments. The brand name is absent for the reason in the header.
function buildTechnosportQuery(sourceProduct) {
  const { styleCode, productName } = parseTechnosportTitle(sourceProduct?.title, sourceProduct?.sku);
  if (styleCode) return styleCode;

  // No code parsed: fall back to the descriptive title, brand removed.
  return productName || normalizeSpace(sourceProduct?.title).replace(LEADING_BRAND_RE, "");
}

// FALLBACK query, used only when the primary found nothing: the descriptive
// title with the brand and the style code removed.
//
// This is what recovers a DELISTED code. B228 and B231 return zero results for
// their code — they are no longer sold — but "Boys Half Sleeve Round Neck
// T-Shirt" returns 128 same-category products, which is the right population
// to score against rather than reporting "no products found".
function buildTechnosportFallbackQuery(sourceProduct) {
  const { productName } = parseTechnosportTitle(sourceProduct?.title, sourceProduct?.sku);
  return productName || normalizeSpace(sourceProduct?.title).replace(LEADING_BRAND_RE, "");
}

// Does a source colour ABBREVIATION denote the destination's colour name?
//
// The source writes "CF", "BS", "NB", "WG", "BEETL", "MYRTL"; the destination
// writes "Chili Flakes", "Black Solid"?, "Navy Blue", "White Grey", "Beetle",
// "Myrtle". There is no published mapping, so three rules are applied in order,
// cheapest first. Returns true only on positive evidence — a false means "not
// shown to be the same colour", not "different colour".
function colourMatches(sourceColourToken, destColourName) {
  const src = String(sourceColourToken || "").toUpperCase().replace(/[^A-Z]/g, "");
  const dst = String(destColourName || "").toUpperCase();
  if (!src || !dst) return false;

  const dstLetters = dst.replace(/[^A-Z]/g, "");

  // 1. Spelled out on both sides, or a clean prefix: BLACK/Black,
  //    BEETL/Beetle, MYRTL/Myrtle, TEAL/Teal, LILAC/Lilac.
  if (dstLetters.startsWith(src) || src.startsWith(dstLetters)) return true;

  // 2. Initials of the destination's words: CF -> Chili Flakes,
  //    NB -> Navy Blue, WG -> White Grey, MB -> Midnight Blue.
  const initials = dst.split(/[^A-Z]+/i).filter(Boolean).map((w) => w[0]).join("");
  if (initials && initials === src) return true;

  // 3. The source token as the initials of a leading subset of the words,
  //    for a three-word colour abbreviated to two ("BS" vs "Black Shadow Grey").
  if (src.length >= 2 && initials.startsWith(src)) return true;

  // 4. First word spelled/prefixed + remaining letters as the later words'
  //    initials. Technosport's own abbreviations mix the two styles:
  //      BM  -> "Black Melange"          (B + M)         — caught by (2)
  //      DCM -> "Dark Carbon Melange"    (D + C + M)     — caught by (2)
  //      BEETL -> "Beetle"                               — caught by (1)
  //    but also, for a colour whose first word is written out:
  //      TEALM -> "Teal Melange"
  //    which neither (1) nor (2) catches, because the token is neither a pure
  //    prefix of the whole string nor pure initials.
  const words = dst.split(/[^A-Z]+/i).filter(Boolean);
  if (words.length >= 2) {
    for (let take = 1; take < words.length; take++) {
      const head = words.slice(0, take).join("");
      const tailInitials = words.slice(take).map((w) => w[0]).join("");
      if (src === head + tailInitials) return true;
      // The head abbreviated to its own prefix ("CHOC" + "M" for
      // "Chocolate Melange").
      if (src.length > tailInitials.length
          && src.endsWith(tailInitials)
          && head.startsWith(src.slice(0, src.length - tailInitials.length))) {
        return true;
      }
    }
  }

  return false;
}

// Does a destination size label cover the source's size?
//
// Not a string comparison, because Technosport states KIDS sizes as RANGES on
// the destination while the source names a single age:
//
//   source "8Y"  (from asin suffix 08Y)   destination ["7-8Y","9-10Y","11-12Y","13-14Y"]
//   source "10Y"                          -> covered by "9-10Y"
//
// A plain equality check therefore reported every kids row as "size not sold",
// which is wrong: B232 and B242 had the right colour and the right style code
// and were still failing on 24 of 24 rows.
//
// Adult sizes stay an exact comparison (S/M/L/XL/2XL), and numeric waist sizes
// likewise, so this only loosens the kids case it was written for.
function sizeIsAvailable(wantSize, availableSizes) {
  const want = String(wantSize || "").trim().toUpperCase();
  if (!want) return false;
  const list = (Array.isArray(availableSizes) ? availableSizes : [])
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
  if (list.length === 0) return false;

  // Exact label, which covers every adult size.
  if (list.includes(want)) return true;

  // "8Y" -> 8. Only year-denominated sizes participate in range matching;
  // "XL" has no number and must not fall through to it.
  const wantYears = /^(\d{1,2})Y$/.exec(want);
  if (!wantYears) return false;
  const n = Number(wantYears[1]);

  for (const label of list) {
    // "7-8Y", "9-10Y", "11 - 12Y"
    const range = /^(\d{1,2})\s*-\s*(\d{1,2})Y$/.exec(label);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (n >= lo && n <= hi) return true;
      continue;
    }
    // A single year on the destination too ("8Y"), already covered by the
    // includes() above but kept for a label written as "08Y".
    const single = /^0?(\d{1,2})Y$/.exec(label);
    if (single && Number(single[1]) === n) return true;
  }

  return false;
}

module.exports = {
  parseTechnosportTitle,
  parseTechnosportAsin,
  buildTechnosportQuery,
  buildTechnosportFallbackQuery,
  colourMatches,
  sizeIsAvailable,
  SIZE_ALIASES,
};
