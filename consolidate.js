// Consolidates the per-chunk output files into one products_matched.json and
// one products_matched_final.json PER DESTINATION, then emails them.
//
// READ-ONLY with respect to the running jobs: reads their output files, writes
// only its own consolidated copies. No service restart, no DB connection.
//
// Two problems this solves:
//   - the run produces one timestamped file set per chunk (45+ so far), not
//     one file;
//   - 27 SKUs appear in more than one file, because a chunk was re-sent after
//     the 13-hour stall and because of earlier single-SKU tests. De-duplicated
//     by SKU, keeping the newest file's version.
//
// Destination is taken from the timing log of the same run id, since the
// output filenames carry the brand, not the destination.
const fs = require("fs");
const zlib = require("zlib");
const sendUpdateReportEmail = require("./helper/sendUpdateReport.js");
const config = require("./config.json");

const PROJECT = 353;
const TO = process.env.REPORT_EMAIL || "jaineel@mergekart.com";
const GMAIL_LIMIT = 24 * 1024 * 1024; // leave headroom under Gmail's ~25MB

// runId -> destination, from the timing logs
const destOf = {};
for (const n of fs.readdirSync("logs")) {
  const m = n.match(/^timing_.*_(\d+)\.log$/);
  if (!m) continue;
  const head = fs.readFileSync("logs/" + n, "utf8").slice(0, 400);
  if (/Nykaa Fashion/.test(head)) destOf[m[1]] = "nykaafashion";
  else if (/Myntra/.test(head)) destOf[m[1]] = "myntra";
}

function collect(prefix) {
  // dest -> sku -> {entry, t}
  const out = { nykaafashion: new Map(), myntra: new Map() };
  const files = fs.readdirSync(".")
    .filter((n) => new RegExp("^" + prefix + "_" + (prefix === "products_matched" ? "(?!final_)" : "") + ".*_" + PROJECT + "_\\d+\\.json$").test(n))
    .map((n) => ({ n, t: Number(n.match(/_(\d+)\.json$/)[1]) }))
    .sort((a, b) => a.t - b.t); // oldest first, so newer overwrites

  let skipped = 0;
  for (const f of files) {
    const dest = destOf[String(f.t)];
    if (!dest) { skipped++; continue; }
    let arr;
    try { arr = JSON.parse(fs.readFileSync(f.n, "utf8")); } catch (e) { continue; }
    for (const e of arr) {
      const sku = e && e.sourceProduct && e.sourceProduct.sku;
      if (sku == null) continue;
      out[dest].set(String(sku), e);
    }
  }
  return { out, files: files.length, skipped };
}

const raw = collect("products_matched");            // every scored candidate
const fin = collect("products_matched_final");      // the winner (or {})

const attachments = [];
const notes = [];
notes.push(`Consolidated output - projectId ${PROJECT}`);
notes.push(`Generated: ${new Date().toISOString()}`);
notes.push(`NOTE: the runs are STILL IN PROGRESS - this is a snapshot.`);
notes.push("");
notes.push(`Source chunk files: products_matched ${raw.files}, products_matched_final ${fin.files}`);
notes.push(`De-duplicated by SKU per destination (newest chunk wins).`);
notes.push("");

for (const dest of ["nykaafashion", "myntra"]) {
  for (const [label, src] of [["products_matched", raw], ["products_matched_final", fin]]) {
    const rows = [...src.out[dest].values()];
    if (rows.length === 0) continue;

    const name = `${label}_${PROJECT}_${dest}.json`;
    fs.writeFileSync(name, JSON.stringify(rows, null, 2), "utf8");
    let size = fs.statSync(name).size;
    let attachName = name;

    // Gzip anything that would blow the mail size limit - JSON compresses ~10x.
    if (size > GMAIL_LIMIT) {
      const gz = name + ".gz";
      fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(name), { level: 9 }));
      const gzSize = fs.statSync(gz).size;
      notes.push(`  ${name}: ${rows.length} products, ${(size / 1048576).toFixed(1)} MB -> gzipped ${(gzSize / 1048576).toFixed(1)} MB (too large to send raw)`);
      attachName = gz; size = gzSize;
    } else {
      notes.push(`  ${name}: ${rows.length} products, ${(size / 1048576).toFixed(2)} MB`);
    }

    if (size <= GMAIL_LIMIT) attachments.push({ filename: attachName, path: attachName });
    else notes.push(`     STILL too large to attach even gzipped - left on the server at ~/product-matching/node/product-matching/${attachName}`);
  }

  const f = fin.out[dest];
  const matched = [...f.values()].filter((e) => e.matchedProducts && Object.keys(e.matchedProducts).length > 0).length;
  notes.push(`  ${dest}: ${f.size} products in final, of which matched: ${matched}`);
  notes.push("");
}

const total = attachments.reduce((a, x) => a + fs.statSync(x.path).size, 0);
notes.push(`Total attachment size: ${(total / 1048576).toFixed(2)} MB`);

(async () => {
  console.log(notes.join("\n"));
  if (attachments.length === 0) { console.log("nothing to attach"); return; }
  if (total > GMAIL_LIMIT) {
    console.log("\nATTACHMENTS EXCEED THE LIMIT IN TOTAL - sending the final files only");
    for (let i = attachments.length - 1; i >= 0; i--) if (!/_final_/.test(attachments[i].filename)) attachments.splice(i, 1);
  }
  await sendUpdateReportEmail({
    from: config.FROM_EMAIL,
    to: TO,
    subject: `Consolidated product matching output - project ${PROJECT} (snapshot, run in progress)`,
    text: notes.join("\n"),
    attachments,
  });
  console.log("\nemailed to " + TO);
  console.log("attached: " + attachments.map((a) => a.filename).join(", "));
})();
