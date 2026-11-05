// Consolidates products_matching_errors_* per destination and emails them.
// READ-ONLY with respect to the running jobs.
const fs = require("fs");
const zlib = require("zlib");
const sendUpdateReportEmail = require("./helper/sendUpdateReport.js");
const config = require("./config.json");

const PROJECT = 353;
const TO = process.env.REPORT_EMAIL || "jaineel@mergekart.com";
const GMAIL_LIMIT = 24 * 1024 * 1024;

// runId -> destination, read from the timing logs (output filenames carry the
// brand, not the destination).
const destOf = {};
for (const n of fs.readdirSync("logs")) {
  const m = n.match(/^timing_.*_(\d+)\.log$/);
  if (!m) continue;
  const head = fs.readFileSync("logs/" + n, "utf8").slice(0, 400);
  if (/Nykaa Fashion/.test(head)) destOf[m[1]] = "nykaafashion";
  else if (/Myntra/.test(head)) destOf[m[1]] = "myntra";
  else if (/Foot Locker/.test(head)) destOf[m[1]] = "footlocker";
}

const DESTS = ["nykaafashion", "myntra", "footlocker"];
const out = Object.fromEntries(DESTS.map((dest) => [dest, new Map()]));
const files = fs.readdirSync(".")
  .filter((n) => new RegExp("^products_matching_errors_.*_" + PROJECT + "_\\d+\\.json$").test(n))
  .map((n) => ({ n, t: Number(n.match(/_(\d+)\.json$/)[1]) }))
  .sort((a, b) => a.t - b.t);

for (const f of files) {
  const dest = destOf[String(f.t)];
  if (!dest) continue;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(f.n, "utf8")); } catch (e) { continue; }
  for (const e of arr) {
    const sku = e && e.sourceProduct && e.sourceProduct.sku;
    if (sku == null) continue;
    // Key on sku+reason: one product can legitimately have more than one
    // reason, but a re-sent chunk must not duplicate the same pair.
    out[dest].set(String(sku) + "||" + String(e.error || ""), e);
  }
}

const notes = [];
const attachments = [];
notes.push(`Consolidated error files - projectId ${PROJECT}`);
notes.push(`Generated: ${new Date().toISOString()}`);
notes.push(`NOTE: runs are STILL IN PROGRESS - this is a snapshot.`);
notes.push("");
notes.push(`Source chunk files: ${files.length}, de-duplicated by (sku + reason).`);
notes.push("");
notes.push(`IMPORTANT: this file is not only hard failures. index.js writes every`);
notes.push(`non-match here too, so "No matching products found" and "No products found"`);
notes.push(`dominate. Genuine failures are "Max retries reached" and HTTP/service errors.`);
notes.push("");

for (const dest of DESTS) {
  const rows = [...out[dest].values()];
  if (!rows.length) { notes.push(`  ${dest}: no error rows`); continue; }

  const byReason = {};
  for (const r of rows) byReason[r.error || "?"] = (byReason[r.error || "?"] || 0) + 1;

  const name = `products_matching_errors_${PROJECT}_${dest}.json`;
  fs.writeFileSync(name, JSON.stringify(rows, null, 2), "utf8");
  let size = fs.statSync(name).size;
  let attachName = name;

  if (size > GMAIL_LIMIT) {
    const gz = name + ".gz";
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(name), { level: 9 }));
    attachName = gz; size = fs.statSync(gz).size;
  }

  notes.push(`  ${dest}: ${rows.length} rows, ${(size / 1048576).toFixed(2)} MB  (${attachName})`);
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    notes.push(`      ${String(v).padStart(5)}  ${k}`);
  }
  notes.push("");
  attachments.push({ filename: attachName, path: attachName });
}

(async () => {
  console.log(notes.join("\n"));
  if (!attachments.length) { console.log("nothing to attach"); return; }
  await sendUpdateReportEmail({
    from: config.FROM_EMAIL,
    to: TO,
    subject: `Product matching error files - project ${PROJECT} (snapshot, run in progress)`,
    text: notes.join("\n"),
    attachments,
  });
  console.log("\nemailed to " + TO);
  console.log("attached: " + attachments.map((a) => a.filename).join(", "));
})();
