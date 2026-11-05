// One-off progress report, emailed.
//
// STRICTLY READ-ONLY with respect to the running jobs: it reads the ledgers
// and writes only its own report files. It does not require
// database/config.js, does not touch index.js, and does not restart anything.
const fs = require("fs");
const path = require("path");
const sendUpdateReportEmail = require("./helper/sendUpdateReport.js");
const config = require("./config.json");

const PROJECT = 353;
const TOTAL = 2852;
const DESTS = ["nykaafashion", "myntra", "footlocker"];
const TO = process.env.REPORT_EMAIL || "jaineel@mergekart.com";

function readLedger(dest) {
  const f = `progress_${PROJECT}_${dest}.jsonl`;
  if (!fs.existsSync(f)) return [];
  // Tolerate a torn final line: the run may be appending as we read.
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const lines = [];
const allMatches = [];

lines.push(`Product matching progress - projectId ${PROJECT}`);
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`NOTE: runs are STILL IN PROGRESS - this is a snapshot, not a final report.`);
lines.push("");

for (const dest of DESTS) {
  const L = readLedger(dest);
  const by = {};
  for (const r of L) by[r.outcome] = (by[r.outcome] || 0) + 1;

  const matches = L.filter((r) => r.outcome === "matched");
  matches.forEach((m) => allMatches.push(Object.assign({ destination: dest }, m)));

  const pct = ((100 * L.length) / TOTAL).toFixed(1);
  lines.push(`${dest}`);
  lines.push(`  processed      : ${L.length} / ${TOTAL}  (${pct}%)`);
  lines.push(`  matched        : ${by.matched || 0}`);
  lines.push(`  no match       : ${by["no-match"] || 0}   (candidates returned, none cleared the threshold)`);
  lines.push(`  no candidates  : ${by["no-candidates"] || 0}   (destination returned nothing for the search)`);
  lines.push(`  errors         : ${by.error || 0}`);

  if (L.length > 1) {
    const t0 = new Date(L[0].at), t1 = new Date(L[L.length - 1].at);
    const per = (t1 - t0) / 1000 / (L.length - 1);
    lines.push(`  avg rate       : ${per.toFixed(1)}s per product`);
    lines.push(`  remaining est. : ${(((TOTAL - L.length) * per) / 3600).toFixed(1)}h at that average`);
  }
  lines.push("");
}

lines.push(`TOTAL MATCHED so far: ${allMatches.length}`);
lines.push("");
lines.push("Match rule in effect: brand >= 0.30 AND composite >= 0.70,");
lines.push("  OR title >= 0.75 AND image >= 0.70 AND brand >= 0.80 (rescue path).");
lines.push("Images are scored for the top 10 candidates per product by text score.");
lines.push("");
lines.push("Observation: matches so far are concentrated in apparel brands (Shrey, Omtex).");
lines.push("Equipment brands (DONIC, HEAD, DSC, ASICS) return substitutes rather than the");
lines.push("product itself, which the composite threshold correctly rejects.");

// Matches as CSV - small, opens straight in Excel.
const csv = ["destination,sku,composite,matched_title,matched_url,completed_at"];
for (const m of allMatches) {
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  csv.push([esc(m.destination), esc(m.sku), esc(m.composite == null ? "" : Number(m.composite).toFixed(3)),
            esc(m.matchedTitle), esc(m.matchedUrl), esc(m.at)].join(","));
}

const sumFile = `progress_report_${PROJECT}_${stamp}.txt`;
const csvFile = `progress_matches_${PROJECT}_${stamp}.csv`;
fs.writeFileSync(sumFile, lines.join("\n"), "utf8");
fs.writeFileSync(csvFile, csv.join("\n"), "utf8");

const attachments = [
  { filename: path.basename(sumFile), path: sumFile },
  { filename: path.basename(csvFile), path: csvFile },
];
// The ledgers themselves - a few hundred KB, well inside Gmail's limit.
for (const dest of DESTS) {
  const f = `progress_${PROJECT}_${dest}.jsonl`;
  if (fs.existsSync(f)) attachments.push({ filename: `progress_${dest}.jsonl`, path: f });
}

(async () => {
  await sendUpdateReportEmail({
    from: config.FROM_EMAIL,
    to: TO,
    subject: `Product matching progress - project ${PROJECT} - ${allMatches.length} matches (run in progress)`,
    text: lines.join("\n"),
    attachments,
  });
  console.log("emailed to", TO);
  console.log("attached:", attachments.map((a) => a.filename).join(", "));
  console.log("\n--- summary ---\n" + lines.join("\n"));
})();
