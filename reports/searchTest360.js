// Search test for project 360: takes the first N SKUs of a brand that have a
// variant (one size row per SKU), searches the destination exactly as a run
// does (search -> mapHit -> variant pick), and writes every candidate's
// scraped data plus the size it matched to reports/. Does not call the
// matching service.
//
//   node reports/searchTest360.js nike Nike 10
//   node reports/searchTest360.js adidas Adidas 10
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const { sequelize } = require(path.join(ROOT, "database/config.js"));
const targetSites = require(path.join(ROOT, "config/targetSites.js"));
const { buildSearchQuery } = require(path.join(ROOT, "helper/searchQuery.js"));
const { pickVariant, productGender } = require(path.join(ROOT, "helper/sizeVariants.js"));

const [, , destination, brand, limitArg] = process.argv;
const limit = Number(limitArg) || 10;
const PROJECT_ID = 360;

(async () => {
  const target = targetSites[destination];
  if (!target) throw new Error(`Unknown destination ${destination}`);

  // First size row of each SKU, SKUs in table order.
  const [rows] = await sequelize.query(
    `select distinct on (sku) id, sku, title, brand, category, variant, description, price, mrp
       from "scratchProducts"
      where "projectId" = :projectId and brand = :brand and variant is not null
      order by sku, id`,
    { replacements: { projectId: PROJECT_ID, brand } }
  );
  const sources = rows.sort((a, b) => a.id - b.id).slice(0, limit);

  const outFile = path.join(__dirname, `search_test_${PROJECT_ID}_${destination}_${Date.now()}.json`);
  const results = [];
  const started = Date.now();

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const query = buildSearchQuery(source);
    const gender = productGender(source);
    const t = Date.now();
    const entry = { sourceProduct: source, sourceVariant: source.variant, gender, searchQuery: query };

    try {
      const hits = await target.searchApi.search(query, source);
      const candidates = hits.map((hit) => target.searchApi.mapHit(hit));
      entry.candidates = candidates.map((c) => {
        const v = pickVariant(source.variant, c.variants, { ...target.variantMatching, gender });
        return { ...c, destinationVariant: v, variantAvailable: Boolean(v) };
      });
      entry.candidateCount = candidates.length;
      entry.candidatesWithVariant = entry.candidates.filter((c) => c.variantAvailable).length;
      entry.exactSkuFound = entry.candidates.some((c) =>
        [c.sku, c.styleCode, c.modelNumber].map((x) => String(x || "").toUpperCase()).includes(String(source.sku).toUpperCase())
      );
    } catch (err) {
      entry.error = err.message;
    }
    entry.seconds = Math.round((Date.now() - t) / 1000);
    results.push(entry);
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

    console.log(
      `${i + 1}/${sources.length} ${source.sku} [${source.variant}] "${source.title}" -> ` +
        (entry.error
          ? `ERROR ${entry.error}`
          : `${entry.candidateCount} candidate(s), ${entry.candidatesWithVariant} with the size, own SKU found: ${entry.exactSkuFound}`) +
        ` (${entry.seconds}s)`
    );
  }

  console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s -> ${outFile}`);
  await sequelize.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
