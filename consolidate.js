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

const PROJECT = parseInt(process.env.PROJECT || "353", 10);
const TOTAL = parseInt(process.env.PROJECT_TOTAL || "2852", 10);
const TO = process.env.REPORT_EMAIL || "jaineel@mergekart.com";
const GMAIL_LIMIT = 24 * 1024 * 1024; // leave headroom under Gmail's ~25MB

// Every destination label that can appear at the head of a timing log, mapped
// to its destination id. The output filenames carry the BRAND, not the
// destination, so the run id is the only link between a file and its target.
const DEST_LABELS = [
  [/Nykaa Fashion/, "nykaafashion"],
  [/Myntra/, "myntra"],
  [/Foot Locker/, "footlocker"],
  [/Puma India/, "puma"],
  [/TechnoSport/, "technosport"],
  [/Speedo India/, "speedo"],
  [/New Balance/, "newbalance"],
  [/Mumzworld/, "mumzworld"],
  [/Nahdi/, "nahdi"],
];

// runId -> destination, from the timing logs
const destOf = {};
for (const n of fs.readdirSync("logs")) {
  const m = n.match(/^timing_.*_(\d+)\.log$/);
  if (!m) continue;
  const head = fs.readFileSync("logs/" + n, "utf8").slice(0, 400);
  const hit = DEST_LABELS.find(([re]) => re.test(head));
  if (hit) destOf[m[1]] = hit[1];
}

// Only the destinations this project actually produced output for, so an empty
// section is not reported for a target that was never run.
const DESTS = process.env.DESTS
  ? process.env.DESTS.split(",").map((s) => s.trim()).filter(Boolean)
  : [...new Set(Object.values(destOf))];

// WHICH FIELD IDENTIFIES A ROW.
//
// Project 353 holds one row per product, so `sku` is the identity and
// de-duplicating on it is correct.
//
// Project 360 holds one row PER VARIATION — 810 Puma rows across 275 skus,
// 433 Technosport across 52, 183 New Balance across 38 — distinguished only by
// `asin`. De-duplicating those on `sku` would silently collapse 810 rows to
// 275 and discard every size but one, so the key is `asin` when the rows carry
// one.
function rowKey(entry) {
  const src = entry && entry.sourceProduct;
  if (!src) return null;
  const asin = src.asin == null ? "" : String(src.asin).trim();
  if (asin) return asin;
  return src.sku == null ? null : String(src.sku);
}

function progressCount(dest) {
  const file = `progress_${PROJECT}_${dest}.jsonl`;
  if (!fs.existsSync(file)) return null;

  const skus = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      // Count VARIATIONS, not skus: the ledger carries `asin` per row for
      // project 360, where one sku spans many sizes. Counting skus there
      // under-reports progress by ~3x.
      if (row && row.asin != null) skus.add(String(row.asin));
      else if (row && row.sku != null) skus.add(String(row.sku));
    } catch (err) {
      // Tolerate a torn final line while a run is appending.
    }
  }

  return skus.size;
}

function collect(prefix) {
  // dest -> sku -> {entry, t}
  const out = Object.fromEntries(DESTS.map((dest) => [dest, new Map()]));
  const files = fs.readdirSync(".")
    .filter((n) => new RegExp("^" + prefix + "_" + (prefix === "products_matched" ? "(?!final_)" : "") + ".*_" + PROJECT + "_\\d+\\.json$").test(n))
    .map((n) => ({ n, t: Number(n.match(/_(\d+)\.json$/)[1]) }))
    .sort((a, b) => a.t - b.t); // oldest first, so newer overwrites

  let skipped = 0;
  for (const f of files) {
    const dest = destOf[String(f.t)];
    // Skip a file whose destination is not in DESTS: the timing logs cover
    // every run ever done in this directory, so a run id can map to a
    // destination this consolidation is not reporting on, and indexing
    // out[dest] for it throws.
    if (!dest || !out[dest]) { skipped++; continue; }
    let arr;
    try { arr = JSON.parse(fs.readFileSync(f.n, "utf8")); } catch (e) { continue; }
    for (const e of arr) {
      // Keyed per VARIATION where the rows have one (project 360), else per
      // sku (project 353). See rowKey().
      const key = rowKey(e);
      if (key == null) continue;
      out[dest].set(key, e);
    }
  }
  return { out, files: files.length, skipped };
}

// Error rows are keyed by sku + reason, not sku alone: index.js writes one row
// per failure reason, and a product can legitimately have more than one, while
// a re-sent chunk must not duplicate the same pair.
function collectErrors() {
  const out = Object.fromEntries(DESTS.map((dest) => [dest, new Map()]));
  const files = fs.readdirSync(".")
    .filter((n) => new RegExp("^products_matching_errors_.*_" + PROJECT + "_\\d+\\.json$").test(n))
    .map((n) => ({ n, t: Number(n.match(/_(\d+)\.json$/)[1]) }))
    .sort((a, b) => a.t - b.t);

  for (const f of files) {
    const dest = destOf[String(f.t)];
    if (!dest || !out[dest]) continue;
    let arr;
    try { arr = JSON.parse(fs.readFileSync(f.n, "utf8")); } catch (e) { continue; }
    for (const e of arr) {
      const key = rowKey(e);
      if (key == null) continue;
      out[dest].set(key + "||" + String(e.error || ""), e);
    }
  }
  return { out, files: files.length };
}

// Splits attachments into groups that each fit under the mail size limit, so
// every file is delivered across several messages rather than the large ones
// being dropped.
function batchAttachments(list, limit) {
  const batches = [];
  let cur = [], curSize = 0;
  for (const a of list) {
    const size = fs.statSync(a.path).size;
    if (curSize + size > limit && cur.length) { batches.push(cur); cur = []; curSize = 0; }
    cur.push(a);
    curSize += size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const raw = collect("products_matched");            // every scored candidate
const fin = collect("products_matched_final");      // the winner (or {})
const err = collectErrors();                        // every failure / non-match reason

const attachments = [];
const notes = [];
notes.push(`Consolidated output - projectId ${PROJECT}`);
notes.push(`Generated: ${new Date().toISOString()}`);
notes.push("");
notes.push(`Source chunk files: products_matched ${raw.files}, products_matched_final ${fin.files}, products_matching_errors ${err.files}`);
notes.push(`De-duplicated by SKU per destination (newest chunk wins); errors by SKU + reason.`);
notes.push("");
notes.push(`NOTE on the errors file: it is not only hard failures. index.js writes every`);
notes.push(`non-match there too, so "No matching products found" / "No products found"`);
notes.push(`dominate. Genuine failures are "Max retries reached", HTTP and socket errors.`);
notes.push(`Progress is shown as processed/total; ${TOTAL} is the expected total project SKU count.`);
notes.push("");

for (const dest of DESTS) {
  const processed = progressCount(dest);
  notes.push(`  ${dest}: processed ${processed == null ? "not started" : `${processed}/${TOTAL}`}`);

  for (const [label, src] of [["products_matched", raw], ["products_matched_final", fin], ["products_matching_errors", err]]) {
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

  // Reason breakdown, so the errors file can be read without opening it. The
  // message is truncated because the HTTP 422 body carries every candidate SKU.
  const reasons = {};
  for (const e of err.out[dest].values()) {
    const key = String(e.error || "?").slice(0, 70);
    reasons[key] = (reasons[key] || 0) + 1;
  }
  const reasonRows = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  if (reasonRows.length) {
    notes.push(`  ${dest}: error reasons -`);
    for (const [k, v] of reasonRows) notes.push(`      ${String(v).padStart(6)}  ${k}`);
  }
  notes.push("");
}

const total = attachments.reduce((a, x) => a + fs.statSync(x.path).size, 0);
notes.push(`Total attachment size: ${(total / 1048576).toFixed(2)} MB`);

(async () => {
  console.log(notes.join("\n"));
  if (attachments.length === 0) { console.log("nothing to attach"); return; }

  // Over the limit in total, send SEVERAL emails rather than dropping files.
  // The previous behaviour kept only `_final_` attachments, which silently
  // discarded both the candidates file and the errors file.
  const batches = total > GMAIL_LIMIT
    ? batchAttachments(attachments, GMAIL_LIMIT)
    : [attachments];

  if (batches.length > 1) {
    console.log(`\nTotal ${(total / 1048576).toFixed(2)} MB exceeds the limit - sending ${batches.length} emails so every file is delivered`);
  }

  // DRY_RUN=1 builds the consolidated files and prints the notes, but sends
  // nothing. Worth having: emailing is not undoable, and a de-duplication key
  // that is wrong for the project silently drops rows (keying project 360 on
  // `sku` instead of `asin` turns Puma's 810 variation rows into 275). Check
  // the counts below against the expected totals before sending.
  if (process.env.DRY_RUN === "1") {
    console.log("\n=== DRY RUN - nothing emailed ===");
    console.log(notes.join("\n"));
    console.log("\nwould attach:");
    for (const a of attachments) {
      console.log(`  ${a.filename} (${(fs.statSync(a.path).size / 1048576).toFixed(2)} MB)`);
    }
    console.log(`\nwould send ${batches.length} email(s) to ${TO}`);
    return;
  }

  for (let i = 0; i < batches.length; i++) {
    const part = batches.length > 1 ? ` (part ${i + 1} of ${batches.length})` : "";
    await sendUpdateReportEmail({
      from: config.FROM_EMAIL,
      to: TO,
      // SUBJECT_PREFIX lets the caller name the brand(s) the mail covers, so a
      // per-brand send is identifiable in an inbox. The destination list is a
      // poor substitute: one consolidation can cover several, and the reader
      // wants the brand. Falls back to the generic wording.
      subject: process.env.SUBJECT_PREFIX
        ? `${process.env.SUBJECT_PREFIX} | project ${PROJECT}${part}`
        : `Consolidated product matching output - project ${PROJECT}${part}`,
      // Only the first message carries the full notes; the rest just list files.
      text: i === 0
        ? notes.join("\n")
        : `Continuation${part} of the consolidated output for project ${PROJECT}.\n\nAttached:\n` +
          batches[i].map((a) => "  " + a.filename).join("\n"),
      attachments: batches[i],
    });
    console.log(`emailed${part} to ${TO}: ` + batches[i].map((a) => a.filename).join(", "));
  }
})();
