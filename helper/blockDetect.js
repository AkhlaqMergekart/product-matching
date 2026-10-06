// Anti-bot interstitials are served with HTTP 200, so a status check alone
// waves them through and the extractors then report "no products found" (or,
// worse, a silently blank field — an Amazon captcha page is what made the
// brandFallback top-up return "" instead of "TEKNUM"). Detecting them turns a
// block into a thrown error, which is what lets a caller rotate onto a
// different exit IP and try again.
//
// Shared by helper/browserClient.js and helper/httpClient.js so both fetch
// paths agree on what "blocked" means.
//
// Both halves of the marker test have to hold. The phrases are specific enough
// on their own, but the size gate is cheap insurance against a real product
// page that happens to mention one of them in a review or a description —
// measured live 2026-09-05, amazon.ae's block pages are ~2-4 KB while its
// genuine product and search pages are 660 KB - 1.5 MB.
const BLOCK_PAGE_MARKERS = [
  /Enter the characters you see below/i,
  /errors[/]validateCaptcha/i,
  /Type the characters you see in this image/i,
  /we just need to make sure you'?re not a robot/i,
  /To discuss automated access to Amazon data/i,
  /Robot Check/i,
  /Access Denied/i,
  /Request unsuccessful[.] Incapsula/i,
  /Checking your browser before accessing/i,
  /Just a moment/i,
  /cf[-_]challenge/i,
  /Attention Required!/i,
  /Cloudflare Ray ID/i,
];

const BLOCK_PAGE_MAX_BYTES = 50000;

// Backstop for block pages whose wording isn't in the list above. Every real
// page any target here serves is enormous — the smallest genuine response
// measured live was a 667 KB Amazon product page, against search pages of
// 0.6-3.3 MB — while the interstitials are 2-4 KB. A response this small is
// never something the extractors can read, so the useful outcome is a throw
// (which rotates onto another exit IP), not a silent "0 products".
//
// This caught a real gap: a 1993-byte amazon.ae response carried none of the
// markers above and came back as a valid page, yielding 0 candidates with no
// error anywhere in the logs.
const MIN_PLAUSIBLE_PAGE_BYTES = 8000;

function isBlockPage(html) {
  if (!html) return true;
  if (html.length < MIN_PLAUSIBLE_PAGE_BYTES) return true;
  if (html.length > BLOCK_PAGE_MAX_BYTES) return false;
  return BLOCK_PAGE_MARKERS.some((marker) => marker.test(html));
}

module.exports = { isBlockPage, MIN_PLAUSIBLE_PAGE_BYTES };
