const XLSX = require("xlsx");

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
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Product Matching");
  XLSX.writeFile(workbook, filePath);

  return filePath;
}

module.exports = { exportResultsToExcel };
