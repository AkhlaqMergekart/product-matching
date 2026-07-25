// Which target sites (from targetSites.js) get checked for each brand, and
// in which direction:
//   "forward" -> take our own catalog rows (ScratchProducts, filtered by
//                brand+projectId) and search for each one on the target site.
//   "reverse" -> search the target site for the brand itself, then check
//                whether each result found there exists in our own catalog
//                rows. Catches listings that exist on a marketplace but were
//                never captured into our catalog at all — the forward
//                direction can't find those, since it only ever starts from
//                rows we already have.
//
// Add a brand here to turn on multi-marketplace matching for it; brands not
// listed here aren't affected and behave exactly as before (only reachable
// via the original single-target /product-matching endpoint, defaulting to
// Nahdi).

const brandTargets = {
  Teknum: [
    { target: "amazonAE", direction: "forward" },
    // { target: "amazonAE", direction: "reverse" },
    { target: "firstcryAE", direction: "forward" },
    // { target: "firstcryAE", direction: "reverse" },
  ],
};

module.exports = brandTargets;
