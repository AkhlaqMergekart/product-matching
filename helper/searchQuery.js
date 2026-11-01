// The text a source product is searched by on a destination marketplace: its
// title, with its brand put in front when the title doesn't already mention
// it (case-insensitive). Some catalogues keep the brand only in its own
// column — project 353 stores "DRIVE DAMP X2" with brand "Babolat" — and a
// query without the brand finds other brands' products.
//
// Only the search query changes; the source product handed to the matching
// service keeps its own title.
function buildSearchQuery(product) {
  const title = String(product?.title || "").trim();
  const brand = String(product?.brand || "").trim();

  if (!brand || title.toLowerCase().includes(brand.toLowerCase())) return title;
  return `${brand} ${title}`;
}

module.exports = { buildSearchQuery };
