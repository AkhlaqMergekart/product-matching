// Reading the SOURCE row's variation from the `variant` column.
//
// This is the field the feed itself publishes as the variation, and it should
// be preferred over re-deriving the size from the `asin` suffix. The asin
// parse was what the first versions of the Puma / Technosport / Speedo /
// New Balance targets used, and it is lossier in two ways:
//
//   1. It drops the SCALE. The column says "uk-7" / "us-8-5"; the asin says
//      only "7" / "8.5". A bare 7 is ambiguous across UK/US/EU, which matters
//      because the destinations state the scale ("UK 7", "7 (UK)").
//
//   2. It collapses an age RANGE to a single age. For kids sizes the column
//      says "7-8-y" — the range Speedo and Technosport actually sell — while
//      the asin says "07Y". Measured over the 313 Speedo rows: the asin parse
//      and the column agree on 201 rows, both are empty on 62 (one-size
//      items), and DIFFER on 50 — every one of them a kids size where the
//      column held the range and the asin a single year.
//
// Formats seen across project 360 (lower-cased, hyphen-separated by the feed):
//
//   letter     "s" "m" "l" "xl" "xxl" "2xl" "xs"
//   plain num  "22" … "48"                      (Speedo/Technosport waist)
//   uk scale   "uk-3" … "uk-13"                 (Puma)
//   us scale   "us-4-5" … "us-12-5"             (New Balance; -5 is the .5)
//   age range  "2-3-y" … "14-15-y"              (Speedo, Technosport)
//
// Returns a shape that keeps BOTH the raw column value and a normalised form,
// so an output row can show what the feed said while the matcher compares on
// something canonical.

const LETTER_SIZES = new Set(["XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "XXXL", "4XL", "5XL"]);

function normalizeSpace(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

// Reads the column, tolerating the array-of-one shape some feeds use.
function rawVariant(sourceProduct) {
  const v = sourceProduct?.variant;
  if (Array.isArray(v)) return normalizeSpace(v[0]);
  return normalizeSpace(v);
}

// Parses the column into { raw, size, scale, ageFrom, ageTo, kind }.
//
//   kind: "letter" | "numeric" | "age-range" | "" (empty / one-size)
//   size: the canonical size WITHOUT the scale — "7", "8.5", "M", "7-8Y"
//   scale: "UK" | "US" | "" — stated only when the column states it
//
// `size` is deliberately scale-free so it can be compared against a
// destination that writes the scale separately, while `scale` is kept for the
// cases where the destination disambiguates (a UK 7 is not a US 7).
function parseSourceVariant(sourceProduct) {
  const raw = rawVariant(sourceProduct);
  if (!raw) return { raw: "", size: "", scale: "", ageFrom: null, ageTo: null, kind: "" };

  const t = raw.toUpperCase();

  // Age range: "7-8-Y", "10-11-Y". Must be tested before the scale forms,
  // since it also contains hyphens and digits.
  const age = /^(\d{1,2})-(\d{1,2})-Y$/.exec(t);
  if (age) {
    return {
      raw,
      size: `${age[1]}-${age[2]}Y`,
      scale: "",
      ageFrom: Number(age[1]),
      ageTo: Number(age[2]),
      kind: "age-range",
    };
  }

  // Single age, in case a feed writes "8-Y".
  const oneAge = /^(\d{1,2})-?Y$/.exec(t);
  if (oneAge) {
    const n = Number(oneAge[1]);
    return { raw, size: `${n}Y`, scale: "", ageFrom: n, ageTo: n, kind: "age-range" };
  }

  // Scale-prefixed numeric: "UK-7", "US-8-5". The trailing "-5" is a half
  // size, NOT a separate token — "us-8-5" is 8.5, not 8 then 5.
  const scaled = /^(UK|US|EU|IND|IN)-(\d{1,2})(?:-(\d))?$/.exec(t);
  if (scaled) {
    const whole = scaled[2];
    const half = scaled[3];
    return {
      raw,
      size: half ? `${whole}.${half}` : whole,
      scale: scaled[1] === "IN" ? "IND" : scaled[1],
      ageFrom: null,
      ageTo: null,
      kind: "numeric",
    };
  }

  // Bare numeric, with or without a decimal: "34", "8.5", "8-5".
  const num = /^(\d{1,2})(?:[.-](\d))?$/.exec(t);
  if (num) {
    return {
      raw,
      size: num[2] ? `${num[1]}.${num[2]}` : num[1],
      scale: "",
      ageFrom: null,
      ageTo: null,
      kind: "numeric",
    };
  }

  // Letter size. "2XL" and "XXL" are the same size; normalised to the numeric
  // form the destinations more commonly print.
  let letter = t.replace(/-/g, "");
  const xs = /^(X{2,5})([SL])$/.exec(letter);
  if (xs) letter = `${xs[1].length}X${xs[2]}`;
  if (LETTER_SIZES.has(letter)) {
    return { raw, size: letter, scale: "", ageFrom: null, ageTo: null, kind: "letter" };
  }

  // Unrecognised: hand back the raw value rather than dropping it, so an
  // unexpected format shows up in the output instead of silently becoming "".
  return { raw, size: raw.toUpperCase(), scale: "", ageFrom: null, ageTo: null, kind: "other" };
}

// Does a destination size LABEL cover this source variant?
//
// The labels are written very differently per site, so each rule here exists
// for a measured case:
//
//   Speedo      "24 (5-6Y)"   numeric + age range in brackets
//   Technosport "7-8Y"        age range only
//   Puma        "UK 7"        scale + number
//   NB          "7.5"         bare number
//   apparel     "34 / M"      waist / letter pair
function variantMatchesLabel(parsed, label) {
  const want = parsed && parsed.size ? String(parsed.size).toUpperCase() : "";
  if (!want) return false;

  const l = normalizeSpace(label).toUpperCase();
  if (!l) return false;

  // Exact, after stripping a scale word the source did not state.
  const bare = l.replace(/\b(UK|US|EU|IND|IN)\b/g, " ").replace(/\s+/g, " ").trim();
  if (l === want || bare === want) return true;

  // "34 / M" and "32 / S": either side may be the size we hold.
  if (l.includes("/")) {
    const parts = l.split("/").map((p) => p.trim());
    if (parts.some((p) => p === want || p.replace(/\b(UK|US|EU)\b/g, "").trim() === want)) return true;
  }

  // Leading token of "24 (5-6Y)" or "7.5 D".
  const head = bare.split(/[\s(]/)[0];
  if (head === want) return true;

  // An age RANGE on either side. The source may hold a range ("7-8Y") and the
  // label a range too, or the label may carry it in brackets after a numeric
  // size ("24 (5-6Y)"). Overlapping ranges count as a match: the feed and the
  // site do not always bracket the ages identically.
  if (parsed.ageFrom != null) {
    const lr = /(\d{1,2})\s*-\s*(\d{1,2})\s*Y/.exec(l);
    if (lr) {
      const lo = Number(lr[1]);
      const hi = Number(lr[2]);
      if (parsed.ageFrom <= hi && parsed.ageTo >= lo) return true;
    }
    const single = /\b0?(\d{1,2})\s*Y\b/.exec(l);
    if (single) {
      const n = Number(single[1]);
      if (n >= parsed.ageFrom && n <= parsed.ageTo) return true;
    }
  }

  return false;
}

// Convenience: does ANY of the destination's size labels cover this variant?
// Returns null — unknown, not false — when the destination published no sizes,
// which happens for candidates below the detail-enrichment cut-off.
function variantAvailable(parsed, labels) {
  const list = (Array.isArray(labels) ? labels : []).map((s) => normalizeSpace(s)).filter(Boolean);
  if (list.length === 0) return null;
  if (!parsed || !parsed.size) return null;
  return list.some((l) => variantMatchesLabel(parsed, l));
}

module.exports = {
  parseSourceVariant,
  variantMatchesLabel,
  variantAvailable,
  rawVariant,
};
