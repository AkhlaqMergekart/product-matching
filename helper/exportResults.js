const XLSX = require("xlsx");

// Without an explicit "!cols" every column renders at Excel's default ~8.43
// chars, which clips both the long headers ("Image Similarity Score") and the
// long values (titles, URLs). Widths are in characters, not pixels.
const MIN_COL_WIDTH = 10;
// URLs run well past 100 chars; letting them auto-fit would push the score
// columns off-screen, so cap and let the cell truncate on display instead.
const MAX_COL_WIDTH = 50;

// Widest of (header, every value in that column), clamped. Derived from the
// row keys rather than a hardcoded list so new columns are covered for free.
function columnWidths(rows) {
  if (!rows.length) return [];

  return Object.keys(rows[0]).map((header) => {
    const widest = rows.reduce(
      (max, row) => Math.max(max, String(row[header] ?? "").length),
      header.length
    );
    // +2 so text isn't flush against the cell border.
    return { wch: Math.min(Math.max(widest + 2, MIN_COL_WIDTH), MAX_COL_WIDTH) };
  });
}

// Flattens the run's results (one row per source product, whether or not a
// match was found) into a sheet the team can scan without reading raw JSON.
function exportResultsToExcel(results, filePath) {
  const rows = results.map((r) => ({
    Target: r.targetLabel,
    Direction: r.direction,
    "Source Title": r.sourceProduct?.title || "",
    "Source Brand": r.sourceProduct?.brand || "",
    "Source SKU": r.sourceProduct?.sku || "",
    "Source URL": r.sourceProduct?.url || "",
    "Source Price": r.sourceProduct?.price ?? "",
    Matched: r.matched ? "Yes" : "No",
    "Matched Title": r.matchedProduct?.title || "",
    "Matched URL": r.matchedProduct?.url || "",
    "Matched Price": r.matchedProduct?.price ?? "",
    "Title Score": r.fieldScores?.title ?? "",
    "Brand Score": r.fieldScores?.brand ?? "",
    "Color Score": r.fieldScores?.color ?? "",
    "Image Similarity Score": r.fieldScores?.image_similarity ?? "",
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = columnWidths(rows);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Product Matching");
  XLSX.writeFile(workbook, filePath);

  return filePath;
}

module.exports = { exportResultsToExcel };
