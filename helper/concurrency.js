// Runs `fn(item, index)` over `items` with at most `limit` calls in flight and
// returns the results in input order. Used for the product-page fetches after a
// search (nike.in, adidas.co.in): each is a separate ScrapeOps request, so ten
// one after another cost ten times the slowest-typical wait.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { mapWithConcurrency };
