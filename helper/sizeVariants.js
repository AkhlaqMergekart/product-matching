// Finds the destination variant that is the same size as a source row's
// `variant` (project 360: "l", "xl", "uk-8", "us-10", "us-8-5", "7-8-y",
// "free-size", "32").
//
// Destination labels are written differently ("UK 6 (EU 40)", "UK 5.5", "XL",
// "2XL", "7-8Y"), so both sides are parsed into size tokens first and the
// tokens compared:
//
//   shoe   { system: "us" | "uk" | "eu", value: 8.5 }
//   alpha  { value: "2xl" }            (xxl and 2xl are the same token)
//   age    { value: "7-8" }            (kids' sizes in years)
//   num    { value: 32 }               (waist sizes, or a shoe size with no system)
//   one    {}                          (free size / one size)
//
// A US source size on a site that lists only UK sizes (nike.in lists "UK 9",
// the client's Nike rows say "us-10") is converted with the brand's chart for
// the product's gender, and the result says so (matchType "converted").

const ALPHA_ALIASES = {
  xxxs: "3xs",
  xxs: "2xs",
  xxl: "2xl",
  xxxl: "3xl",
  xxxxl: "4xl",
  small: "s",
  medium: "m",
  large: "l",
};
const ALPHA_SIZES = new Set(["4xs", "3xs", "2xs", "xs", "s", "m", "l", "xl", "2xl", "3xl", "4xl", "5xl"]);
const ONE_SIZE = /^(free[\s-]?size|one[\s-]?size|os|ns|osfa|no[\s-]?size)$/;

function round(value) {
  return Math.round(value * 10) / 10;
}

// "8-5" (the client's form) and "8.5" both mean eight and a half.
function shoeNumber(text) {
  return round(parseFloat(String(text).replace(/[-_](5)$/, ".$1")));
}

// Every size token a label carries. "UK 6 (EU 40)" gives two shoe tokens.
function parseSize(label) {
  // adidas shorts and tights add the inseam: '2XS 3"' is still a 2XS.
  const text = String(label ?? "").trim().toLowerCase().replace(/_/g, "-").replace(/\s+\d+(\.\d+)?\s*("|in|inch)$/, "");
  if (!text) return [];
  if (ONE_SIZE.test(text)) return [{ kind: "one" }];

  const tokens = [];
  // A trailing "h" is a half size: ASICS labels "US10H/UK9H" (US 10.5).
  const shoe = /\b(us|uk|eu)\s*[-:]?\s*(\d{1,2}(?:[.-]5)?)(h)?(?![\d.])/g;
  for (let m; (m = shoe.exec(text)); ) {
    tokens.push({ kind: "shoe", system: m[1], value: shoeNumber(m[2]) + (m[3] ? 0.5 : 0) });
  }
  if (tokens.length) return tokens;

  const age = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})\s*-?\s*(y|yrs?|years?)$/);
  if (age) return [{ kind: "age", value: `${Number(age[1])}-${Number(age[2])}` }];

  const alpha = ALPHA_ALIASES[text] || text;
  if (ALPHA_SIZES.has(alpha)) return [{ kind: "alpha", value: alpha }];

  // Two-size bands: caps and socks ("l-xl" in project 360, "L/XL" on nike.in).
  const band = text.match(/^([a-z0-9]+)\s*[-/]\s*([a-z0-9]+)$/);
  if (band) {
    const [a, b] = [ALPHA_ALIASES[band[1]] || band[1], ALPHA_ALIASES[band[2]] || band[2]];
    if (ALPHA_SIZES.has(a) && ALPHA_SIZES.has(b)) return [{ kind: "band", value: `${a}-${b}` }];

    // A WAIST / LETTER pair, which is one size written two ways rather than a
    // band: Speedo lists "32 / S", "34 / M". Both halves are emitted so a
    // source row holding either form matches — the client's Speedo rows say
    // "32" while its Technosport rows say "m" for the same kind of garment.
    const numeric = /^\d{1,2}(?:[.-]5)?$/.test(a) ? a : (/^\d{1,2}(?:[.-]5)?$/.test(b) ? b : null);
    const alphaHalf = ALPHA_SIZES.has(a) ? a : (ALPHA_SIZES.has(b) ? b : null);
    if (numeric && alphaHalf) {
      return [{ kind: "num", value: shoeNumber(numeric) }, { kind: "alpha", value: alphaHalf }];
    }
  }

  if (/^\d{1,2}(?:[.-]5)?$/.test(text)) return [{ kind: "num", value: shoeNumber(text) }];

  return [{ kind: "raw", value: text }];
}

function sameToken(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "one") return true;
  if (a.kind === "shoe") return a.system === b.system && a.value === b.value;
  return a.value === b.value;
}

// Who the product is for, which decides the US<->UK offset. Read from the
// source row: project 360 categories are "Women's Footwear > ...", Nike titles
// start "W NIKE ..." for women's and carry "GS"/"PS"/"TD" for kids'.
function productGender(product) {
  const text = `${product?.category || ""} ${product?.title || ""}`;
  if (/\b(kid'?s?|boys?|girls?|junior|youth|infant|toddler|gs|ps|td|bp|bg|gg)\b/i.test(text)) return "kids";
  if (/\bwomen'?s?\b|\bwmns\b|^\s*w\s/i.test(text)) return "women";
  return "men";
}

// conversion: { men, women, kids } = how much smaller the UK number is than
// the US one for this brand (Nike men's US 10 = UK 9 -> men: 1).
function convertShoe(token, toSystem, conversion, gender) {
  const offset = conversion?.[gender];
  if (offset == null || token.kind !== "shoe") return null;
  if (token.system === "us" && toSystem === "uk") return { kind: "shoe", system: "uk", value: round(token.value - offset) };
  if (token.system === "uk" && toSystem === "us") return { kind: "shoe", system: "us", value: round(token.value + offset) };
  return null;
}

// Picks the destination variant matching `sourceVariant`, or null when the
// product doesn't come in that size.
//
// variants: [{ label, ...anything }] as scraped.
// options.conversion: the site's US/UK chart (see convertShoe).
// options.bareShoeSystem: what a plain number on the site means for a shoe
//   ("uk" for Indian stores), so "uk-8" matches a label of just "8".
// options.gender: "men" | "women" | "kids" (productGender of the source row).
function pickVariant(sourceVariant, variants, options = {}) {
  const wanted = parseSize(sourceVariant);
  if (wanted.length === 0) return null;
  const list = Array.isArray(variants) ? variants : [];

  const parsed = list.map((variant) => {
    let tokens = parseSize(variant.label);
    if (options.bareShoeSystem) {
      tokens = tokens.map((t) => (t.kind === "num" ? { kind: "shoe", system: options.bareShoeSystem, value: t.value } : t));
    }
    return { variant, tokens };
  });

  const find = (targets) =>
    parsed.find(({ tokens }) => tokens.some((t) => targets.some((w) => sameToken(t, w))));

  const exact = find(wanted);
  if (exact) return { ...exact.variant, matchType: "exact" };

  // A free-size source matches a product sold in a single size.
  if (wanted[0].kind === "one" && list.length <= 1) {
    return { ...(list[0] || { label: "" }), matchType: list.length ? "single size" : "no sizes listed" };
  }

  // Shoe size in another system: convert and try again.
  for (const toSystem of ["uk", "us"]) {
    const converted = wanted.map((w) => convertShoe(w, toSystem, options.conversion, options.gender)).filter(Boolean);
    if (converted.length === 0) continue;
    const hit = find(converted);
    if (hit) {
      const c = converted[0];
      return {
        ...hit.variant,
        matchType: "converted",
        conversion: `${sourceVariant} -> ${c.system.toUpperCase()} ${c.value} (${options.gender} size chart)`,
      };
    }
  }

  return null;
}

module.exports = { parseSize, pickVariant, productGender };
