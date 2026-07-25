const axios = require("axios");
const fs = require("fs");
const cheerio = require("cheerio");
const xpath = require("xpath");
const dom = require("xmldom").DOMParser;
const puppeteer = require("puppeteer");
const express = require("express");
const app = express();
const sendUpdateReportEmail = require("./helper/sendUpdateReport.js");
const { fetchHtml } = require("./helper/scrapeClient.js");
const { exportResultsToExcel } = require("./helper/exportResults.js");
const targetSites = require("./config/targetSites.js");
const brandTargets = require("./config/brandTargets.js");

require("./database/config.js");

const ScratchProducts = require("./models/scratchProducts.js");

const MATCH_THRESHOLD = 0.85;
const MATCH_FIELD_KEYS = ["title", "brand", "color", "image_similarity"];

function appendToFile(filename, data) {
    // Read the file
    return new Promise((resolve, reject) => {

        // Check if the file exists
        if (!fs.existsSync(filename)) {
            // If not, create it with an empty array
            fs.writeFileSync(filename, JSON.stringify([], null, 2), 'utf8');
        }

        fs.readFile(filename, 'utf8', (err, fileData) => {
            if (err) throw err;
            // Parse the JSON data
            let arr = JSON.parse(fileData);

            // Append the data
            if (Array.isArray(data)) {
                console.log(data.length);
                arr = arr.concat(data);
            } else {
                const found = arr.find(itm => itm === data);
                if (!found) {
                    arr.push(data);
                }
            }

            // Write the updated array back to the file
            fs.writeFile(filename, JSON.stringify(arr, null, 2), 'utf8', (err) => {
                if (err) reject(err);
                resolve();
            });
        });
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Searches `targetConfig`'s site for `query` and returns a full list of
// candidate product objects, ready to hand to the matching service. This is
// the piece that used to be hardcoded to Nahdi — every site-specific fact
// (search URL, listing/detail selectors, which proxy client to use) comes
// from targetConfig (config/targetSites.js) instead.
async function buildCandidatesFromSearch(targetConfig, query) {
    const searchUrl = targetConfig.buildSearchUrl(query);

    let searchHtml;
    try {
        searchHtml = await fetchHtml(targetConfig.scraper, searchUrl);
    } catch (err) {
        console.error(`Error searching ${targetConfig.label} for "${query}":`, err.message);
        return [];
    }

    const $ = cheerio.load(searchHtml);
    const doc = new dom().parseFromString($.xml(), "text/xml");

    // Some targets (Amazon UAE) carry enough data on the search-results page
    // itself, so there's no per-candidate detail fetch at all.
    if (!targetConfig.needsDetailFetch) {
        return targetConfig.extractListingProducts(doc);
    }

    const productLinks = targetConfig.extractListingLinks(doc);
    if (productLinks.length === 0) {
        console.log(`No products found on ${targetConfig.label} for:`, query);
        return [];
    }

    const candidates = [];
    for (let i = 0; i < productLinks.length; i++) {
        const link = productLinks[i];

        // Throttle between product detail requests.
        await delay(1000);

        let detailHtml = null;
        try {
            detailHtml = await fetchHtml(targetConfig.scraper, link);
        } catch (err) {
            console.error(`Error fetching ${targetConfig.label} product page:`, link, err.message);
            continue; // Skip this link, keep processing the rest of the batch
        }

        const $$ = cheerio.load(detailHtml);
        const detailDoc = new dom().parseFromString($$.xml(), "text/xml");

        try {
            candidates.push(targetConfig.extractDetail(detailDoc, link));
        } catch (err) {
            console.error(`Error parsing ${targetConfig.label} product page:`, link, err.message);
        }
    }

    return candidates;
}

// Sends originalProduct + candidates to the matching microservice in
// batches of 5 (unchanged from the original Nahdi flow) and returns the
// flattened field-score results.
async function callMatchingService(originalProduct, comparableProducts) {
    originalProduct.price = originalProduct.price ? parseFloat(originalProduct.price) : 0;
    originalProduct.mrp = originalProduct.mrp ? parseFloat(originalProduct.mrp) : 0;

    let matchData = [];
    const batchSize = 5;

    for (let i = 0; i < comparableProducts.length; i += batchSize) {
        const batch = comparableProducts.slice(i, i + batchSize);

        const config = {
            method: 'post',
            maxBodyLength: Infinity,
            url: "http://localhost:8000/api/match",
            headers: {
                'accept': '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'content-type': 'application/json',
                'origin': 'https://www.mumzworld.com',
                'referer': 'https://www.mumzworld.com/',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
                'X-API-Key': "test123#"
            },
            data: {
                "original_product": originalProduct,
                "comparable_products": batch,
                "include_image_similarity": true
            },
            timeout: 120000
        };

        const matchResponse = await axios.request(config);
        matchData = matchData.concat(matchResponse.data);
    }

    return matchData;
}

// Applies the "all four scores >= 0.85" rule (unchanged threshold) and
// returns the first candidate that clears it, or null.
function pickBestMatch(matchData) {
    for (let i = 0; i < matchData.length; i++) {
        const fieldScores = matchData[i].field_scores;
        const clearsThreshold = fieldScores && MATCH_FIELD_KEYS.every((key) => fieldScores[key] >= MATCH_THRESHOLD);

        if (clearsThreshold) {
            return { matchedProduct: matchData[i], fieldScores };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Legacy Mumzworld -> Nahdi flow (original, unrefactored implementation).
// Pulls source rows by SKU list + projectId, searches Nahdi directly via the
// ScrapeOps proxy, scrapes each product page with cheerio/xpath, and matches
// against the matching microservice. Existing callers of POST
// /product-matching keep working exactly as before.
// ---------------------------------------------------------------------------
async function productMatching(brands, projectId, category) {
    try {

        console.log("Starting product matching for brand:", brands.join(", "), "and projectId:", projectId, "and category:", category || "All");

        if (!brands || brands.length == 0 || !projectId) {
            console.error("Brand and projectId are required parameters.");
            throw new Error("Brand and projectId are required parameters.");
        }

        const browser = await puppeteer.launch({
            args: [
                "--no-sandbox",
                "--proxy-server=http://p.webshare.io:80",
                "--disabled-setupid-sandbox",
            ],
            headless: true,
            waitForInitialPage: 10000,
        });

        // for (var z = 0; z < brands.length; z++) {

        // const brand = brands[z];

        const sourceProducts = await ScratchProducts.findAll({
            where: {
                sku: { [Op.in]: brands.map(itm => itm.toString()) },
                projectId: projectId
            },
            // limit: 1,
            raw: true,
            attributes: ['title', 'url', 'brand', 'sku', 'category', 'images', 'attributes', 'price', 'mrp']
        });

        const brand = sourceProducts[0].brand;

        console.log("Brand: ", sourceProducts[0].brand, "Source products count:", sourceProducts.length);

        let retryCount = 0;
        let lastProcessedIndex = -1;

        const outputFilePath = `products_matched_final_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const errorFilePath = `products_matching_errors_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const matchedFilePath = `products_matched_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const emptyFilePath = `emptyFile.json`

        for (var x = 0; x < sourceProducts.length; x++) {

            const sourceProduct = sourceProducts[x];

            // Reset the retry counter only when we advance to a genuinely new
            // product. Retries keep the same index (via x = x - 1), so this keeps
            // the counter per-product instead of leaking across products.
            if (x !== lastProcessedIndex) {
                retryCount = 0;
                lastProcessedIndex = x;
            }

            // Throttle between products to stay under proxy / site rate limits.
            await delay(1500);

            const url = `https://www.nahdionline.com/en-sa/search?query=${encodeURIComponent(sourceProduct.title)}`;

            console.log(x, sourceProduct.title, url);

            let htmlResponse = null;
            try {
                let premium_level = "level_1";

                if (retryCount >= 2) {
                    premium_level = "level_2";
                }

                let config = {
                    method: 'get',
                    maxBodyLength: Infinity,
                    url: `https://proxy.scrapeops.io/v1/?api_key=6aa09d27-c12a-49b1-9332-b0fe571795c2&url=${url}&render_js=true&premium=${premium_level}`,
                    headers: {}
                };

                const response = await axios.request(config);
                htmlResponse = response.data;
            } catch (err) {
                console.error("Error navigating to URL:", err);
                retryCount++;
                if (retryCount >= 3) {
                    console.error("Max retries reached for source product:", sourceProduct.title);
                    await appendToFile(errorFilePath, {
                        sourceProduct: sourceProduct,
                        error: "Max retries reached"
                    });
                    continue; // Skip to the next source product
                } else {
                    x = x - 1; // Decrement x to retry the current source product
                    continue; // Skip to the next source product
                }

            }

            const $ = cheerio.load(htmlResponse);

            const doc = new dom().parseFromString($.xml(), 'text/xml');

            let productLinks = xpath.select("//a[@class='flex h-full flex-col']", doc).map(itm => "https://www.nahdionline.com" + itm.getAttribute("href"));

            if (productLinks.length === 0) {
                console.log("No products found for:", sourceProduct.title);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No products found"
                });

                continue; // Skip to the next source product if no products found
            }

            console.log("Found products:", productLinks.length);

            const productBatches = [];
            // Process each product link
            const productPage = await browser.newPage();
            try {

                for (let i = 0; i < productLinks.length; i++) {
                    const link = productLinks[i];
                    console.log("Processing link:", link);

                    // Throttle between product detail requests.
                    await delay(1000);

                    // Retry this single link up to 3 times (escalating to premium
                    // rendering after the first failure) instead of letting a
                    // transient proxy error (e.g. 502) abort the entire batch.
                    let productResponse = null;
                    let linkError = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            const premium_level = attempt >= 2 ? "level_2" : "level_1";

                            let config = {
                                method: 'get',
                                maxBodyLength: Infinity,
                                url: `https://proxy.scrapeops.io/v1/?api_key=6aa09d27-c12a-49b1-9332-b0fe571795c2&url=${link}&render_js=true&premium=${premium_level}`,
                                headers: {}
                            };

                            const response = await axios.request(config);
                            productResponse = response.data;
                            linkError = null;
                            break;
                        } catch (err) {
                            linkError = err;
                            console.error(`Error fetching product link (attempt ${attempt}/3):`, link, err.message);
                            if (attempt < 3) {
                                await delay(1000);
                            }
                        }
                    }

                    if (linkError) {
                        console.error("Max retries reached for product link:", link);
                        await appendToFile(errorFilePath, {
                            sourceProduct: sourceProduct,
                            link: link,
                            error: linkError.message
                        });
                        continue; // Skip this link, keep processing the rest of the batch
                    }

                    const $ = cheerio.load(productResponse);

                    const doc = new dom().parseFromString($.xml(), "text/xml");

                    const category = xpath.select("//ul[@class='flex items-center text-custom-xs font-semibold text-gray ']/li", doc)?.map(itm => itm.textContent).join(" > ");
                    const brand = xpath.select("//div[@class='flex items-center space-x-2 empty:hidden rtl:space-x-reverse']", doc)?.[0]?.textContent;
                    const title = xpath.select("//h1", doc)?.[0]?.textContent;
                    const price = xpath.select("//div[@class='flex items-center text-primary-red']", doc)?.[0]?.textContent;
                    const mrp = xpath.select("//div[@class='items-center mx-2 flex text-lg text-gray-500 line-through']", doc)?.[0]?.textContent
                    const express = xpath.select("//div[@class='ms-1 flex min-w-fit flex-row']/img", doc).length > 0 ? true : false;
                    const description = xpath.select("//div[@class='pdp-about-section']", doc);
                    const totalRating = xpath.select("//span[@class='flex items-center gap-2 text-2xl font-semibold']", doc)?.[0]?.textContent;
                    const totalReview = xpath.select("//span[@class='hidden text-xl lg:block']", doc)?.[0]?.textContent;
                    // console.log(xpath.select("//img[@class='relative h-full w-full object-contain transition duration-300 ease-in-out group-hover:scale-105']", doc).length)
                    const images = xpath.select("//img[@class='relative h-full w-full object-contain transition duration-300 ease-in-out group-hover:scale-105']", doc).map(itm => itm.getAttribute("src"))
                    // console.log(description.length)
                    console.log(images)
                    const product = {
                        url: link,
                        category: category || "",
                        brand: brand || "",
                        title: title || "",
                        sku: link.split("/").pop().split("?")[0] || "",
                        price: parseFloat(price) || parseFloat(mrp) || 0,
                        mrp: parseFloat(mrp) || 0,
                        totalRating: totalRating || "",
                        totalReview: totalReview || "",
                        express: express || false,
                        description: description[0]?.textContent || "",
                        images: images || []
                    };

                    productBatches.push(product);

                }

            } catch (error) {
                console.error("Error processing product links:", error);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: error.message
                });

                continue; // Skip to the next source product if there's an error
            }

            if (productBatches.length === 0) {
                console.log("No products found for:", sourceProduct.title);
                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No products found"
                });
                continue; // Skip to the next source product if no products found
            }

            console.log("Found products in batch:", productBatches.length);

            let matchData = [];
            try {
                const batchSize = 5;
                // Split the productBatches into smaller batches
                for (let i = 0; i < productBatches.length; i += batchSize) {
                    const batch = productBatches.slice(i, i + batchSize);

                    console.log("Matching batch:", i / batchSize + 1, "of", Math.ceil(productBatches.length / batchSize));

                    sourceProduct.price = sourceProduct.price ? parseFloat(sourceProduct.price) : 0;
                    sourceProduct.mrp = sourceProduct.mrp ? parseFloat(sourceProduct.mrp) : 0;

                    const jsonBody = {
                        "original_product": sourceProduct,
                        "comparable_products": batch,
                        "include_image_similarity": true
                    };

                    const config = {
                        method: 'post',
                        maxBodyLength: Infinity,
                        url: "http://localhost:8000/api/match",
                        headers: {
                            'accept': '*/*',
                            'accept-language': 'en-US,en;q=0.9',
                            'content-type': 'application/json',
                            'origin': 'https://www.mumzworld.com',
                            'referer': 'https://www.mumzworld.com/',
                            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
                            'X-API-Key': "test123#"
                        },
                        data: jsonBody,
                        timeout: 120000
                    };

                    const matchResponse = await axios.request(config);

                    matchData = matchData.concat(matchResponse.data);

                }
            } catch (error) {
                console.log(error);
                console.error("Error matching products:", error);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: error.message
                });

                continue; // Skip to the next source product if there's an error
            }

            if (matchData.length === 0) {
                console.log("No match data found for:", sourceProduct.title);
                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No match data found"
                });
                continue; // Skip to the next source product if no match data found
            }

            console.log("Match data found:", matchData.length);

            await appendToFile(matchedFilePath, {
                sourceProduct: sourceProduct,
                matchedProducts: matchData,
            });

            let foundProductCount = 0;
            try {

                for (var i = 0; i < matchData.length; i++) {

                    const fieldScores = matchData[i].field_scores;

                    if (fieldScores && fieldScores.title >= 0.85 && fieldScores.brand >= 0.85 && fieldScores.color >= 0.85 && fieldScores.image_similarity >= 0.85) {
                        const finalObj = {
                            sourceProduct: sourceProduct,
                            matchedProducts: matchData[i],
                        };

                        await appendToFile(outputFilePath, finalObj);
                        foundProductCount++;
                        break; // Break after finding the first match
                    }

                }


            } catch (error) {
                console.error("Error processing match data:", error);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: error.message
                });

                continue; // Skip to the next source product if there's an error
            }

            if (foundProductCount === 0) {
                console.log("No matching products found for:", sourceProduct.title);

                await appendToFile(errorFilePath, {
                    sourceProduct: sourceProduct,
                    error: "No matching products found"
                });

                await appendToFile(outputFilePath, {
                    sourceProduct: sourceProduct,
                    matchedProducts: {}
                });

            } else {
                console.log(`Found ${foundProductCount} matching products for:`, sourceProduct.title);
            }

        }
        const allProducts = fs.existsSync(outputFilePath) ? JSON.parse(fs.readFileSync(outputFilePath, "utf8")) : [];
        console.log("Total matched products:", allProducts.length);

        console.log("Product matching completed successfully.");

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: "akhlaq@mergekart.com",
            subject: `Product Matching Report for ${brand} - ${projectId}`,
            text: `Product matching completed successfully for brand: ${brand} and projectId: ${projectId}. Total matched products: ${allProducts.length}`,
            attachments: [
                {
                    filename: 'products_matched_final.json',
                    path: fs.existsSync(outputFilePath) ? outputFilePath : emptyFilePath,
                },
                {
                    filename: 'products_matching_errors.json',
                    path: fs.existsSync(errorFilePath) ? errorFilePath : emptyFilePath,
                },
                {
                    filename: 'products_matched.json',
                    path: fs.existsSync(matchedFilePath) ? matchedFilePath : emptyFilePath,
                }
            ]
        };

        await sendUpdateReportEmail(mailOptions);

        // if (fs.existsSync(outputFilePath)) {
        //     fs.unlinkSync(outputFilePath);
        // }

        // if (fs.existsSync(errorFilePath)) {
        //     fs.unlinkSync(errorFilePath);
        // }

        // if (fs.existsSync(matchedFilePath)) {
        //     fs.unlinkSync(matchedFilePath);
        // }
        // }

        await browser.close();


    } catch (err) {
        console.error("Error:", err);
        const mailOptions = {
            from: config.FROM_EMAIL,
            to: "akhlaq@mergekart.com",
            subject: `Product Matching Error for ${brands.join(", ")} - ${projectId}`,
            text: `An error occurred during product matching for brand: ${brands.join(", ")} and projectId: ${projectId}. Error: ${err.message}`,
        };

        await sendUpdateReportEmail(mailOptions);
    }
}

// ---------------------------------------------------------------------------
// New brand-driven flow: looks up every {target, direction} pair configured
// for `brandName` in config/brandTargets.js and runs all of them, combining
// results into one spreadsheet. This is what powers the Teknum x Amazon
// UAE / Firstcry UAE (forward + reverse) checks.
// ---------------------------------------------------------------------------
async function runBrandMatching(brandName, projectId) {
    const targets = brandTargets[brandName];
    if (!targets || targets.length === 0) {
        throw new Error(`No target sites configured for brand "${brandName}" in config/brandTargets.js`);
    }

    // The brand's own catalog rows — used as the source list for "forward"
    // checks, and as the comparison pool for "reverse" checks.
    const localCatalog = await ScratchProducts.findAll({
        where: { brand: { [Op.iLike]: brandName }, projectId },
        raw: true,
        attributes: ['title', 'url', 'brand', 'sku', 'category', 'images', 'attributes', 'price', 'mrp']
    });

    if (localCatalog.length === 0) {
        throw new Error(`No catalog rows found for brand "${brandName}" and projectId ${projectId}`);
    }

    const runId = Date.now();
    const errorFilePath = `brand_matching_errors_${brandName}_${projectId}_${runId}.json`;
    const matchedFilePath = `brand_matching_raw_${brandName}_${projectId}_${runId}.json`;
    const excelFilePath = `brand_matching_${brandName}_${projectId}_${runId}.xlsx`;
    const allResults = [];

    for (const { target: targetId, direction } of targets) {
        const targetConfig = targetSites[targetId];
        if (!targetConfig) {
            console.error(`Unknown target site "${targetId}" in brandTargets config, skipping.`);
            continue;
        }

        console.log(`Running ${direction} check for ${brandName} against ${targetConfig.label}`);

        if (direction === "forward") {
            // Same shape as the legacy flow: iterate our own catalog rows,
            // search the target for each one.
            for (const sourceProduct of localCatalog) {
                await delay(1500);

                const candidates = await buildCandidatesFromSearch(targetConfig, sourceProduct.title);
                if (candidates.length === 0) {
                    await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct, error: "No products found" });
                    continue;
                }

                let matchData = [];
                try {
                    matchData = await callMatchingService(sourceProduct, candidates);
                } catch (err) {
                    await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct, error: err.message });
                    continue;
                }

                await appendToFile(matchedFilePath, { direction, target: targetConfig.label, sourceProduct, matchedProducts: matchData });

                const best = pickBestMatch(matchData);
                allResults.push({
                    targetLabel: targetConfig.label,
                    direction,
                    sourceProduct,
                    matched: !!best,
                    matchedProduct: best ? best.matchedProduct : null,
                    fieldScores: best ? best.fieldScores : null,
                });
            }
        }
        // Reverse direction disabled for now (out of scope per current HLD —
        // forward-only). Left in place, commented, rather than deleted:
        // else if (direction === "reverse") {
        //     // Search the target site for the brand itself, then check each
        //     // result found there against our own catalog. NOTE: this only
        //     // covers the first page of results the target returns for the
        //     // brand-name query — no pagination yet. Good enough to surface
        //     // "things listed under this brand that we don't have tracked,"
        //     // but not an exhaustive crawl of the target site.
        //     const targetSideProducts = await buildCandidatesFromSearch(targetConfig, brandName);
        //
        //     for (const targetSideProduct of targetSideProducts) {
        //         await delay(1500);
        //
        //         let matchData = [];
        //         try {
        //             matchData = await callMatchingService(targetSideProduct, localCatalog);
        //         } catch (err) {
        //             await appendToFile(errorFilePath, { direction, target: targetConfig.label, sourceProduct: targetSideProduct, error: err.message });
        //             continue;
        //         }
        //
        //         await appendToFile(matchedFilePath, { direction, target: targetConfig.label, sourceProduct: targetSideProduct, matchedProducts: matchData });
        //
        //         const best = pickBestMatch(matchData);
        //         allResults.push({
        //             targetLabel: targetConfig.label,
        //             direction,
        //             sourceProduct: targetSideProduct,
        //             matched: !!best,
        //             matchedProduct: best ? best.matchedProduct : null,
        //             fieldScores: best ? best.fieldScores : null,
        //         });
        //     }
        // }
    }

    exportResultsToExcel(allResults, excelFilePath);

    const matchedCount = allResults.filter((r) => r.matched).length;

    const mailOptions = {
        from: config.FROM_EMAIL,
        to: "akhlaq@mergekart.com",
        subject: `Product Matching Report for ${brandName} - ${projectId}`,
        text: `Multi-marketplace product matching completed for brand: ${brandName}, project: ${projectId}. ${matchedCount}/${allResults.length} rows matched. See attached spreadsheet.`,
        attachments: [
            { filename: 'product_matching_results.xlsx', path: excelFilePath },
            { filename: 'product_matching_raw.json', path: fs.existsSync(matchedFilePath) ? matchedFilePath : `emptyFile.json` },
            { filename: 'product_matching_errors.json', path: fs.existsSync(errorFilePath) ? errorFilePath : `emptyFile.json` },
        ]
    };

    await sendUpdateReportEmail(mailOptions);

    return { excelFilePath, totalRows: allResults.length, matchedCount };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const config = require("./config.json");
const { Op } = require('sequelize');

app.post('/product-matching', async (req, res) => {
    const { brand, projectId, category } = req.body;
    console.log(brand)
    if (!brand || brand.length == 0 || !projectId) {
        return res.status(400).json({ error: "Brand and projectId are required parameters." });
    }

    try {

        res.status(200).json({ message: "Product matching started successfully." });

        await productMatching(brand, projectId, category);

        console.log("Product matching completed successfully.");
    } catch (error) {
        console.error("Error in product matching:", error);

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: "akhlaq@mergekart.com",
            subject: `Product Matching Error for ${brand} - ${projectId}`,
            text: `An error occurred during product matching for brand: ${brand} and projectId: ${projectId}. Error: ${error.message}`,
        };

        await sendUpdateReportEmail(mailOptions);

        res.status(500).json({ error: "An error occurred during product matching." });
    }
});

// New: config-driven, multi-target (+ reverse-check) matching for a whole
// brand, e.g. { "brandName": "Teknum", "projectId": 240 }. Which target
// sites and directions run is controlled entirely by config/brandTargets.js.
app.post('/product-matching/brand', async (req, res) => {
    const { brandName, projectId } = req.body;

    if (!brandName || !projectId) {
        return res.status(400).json({ error: "brandName and projectId are required parameters." });
    }

    try {
        res.status(200).json({ message: "Brand product matching started successfully." });

        const result = await runBrandMatching(brandName, projectId);

        console.log("Brand product matching completed successfully.", result);
    } catch (error) {
        console.error("Error in brand product matching:", error);

        const mailOptions = {
            from: config.FROM_EMAIL,
            to: "akhlaq@mergekart.com",
            subject: `Product Matching Error for ${brandName} - ${projectId}`,
            text: `An error occurred during brand product matching for brand: ${brandName} and projectId: ${projectId}. Error: ${error.message}`,
        };

        await sendUpdateReportEmail(mailOptions);
    }
});

app.get("/test", async (req, res) => {
    return res.status(200).json({ message: "API is working fine." });
});

app.listen(8010, () => {
    console.log("Server is running on port 8010");
});
