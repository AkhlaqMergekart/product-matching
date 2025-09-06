const axios = require('axios');
const fs = require('fs');
const cheerio = require('cheerio');
const xpath = require('xpath');
const dom = require('xmldom').DOMParser;
const puppeteer = require('puppeteer');
const express = require('express');
const app = express();
const sendUpdateReportEmail = require("./helper/sendUpdateReport.js");

require("./database/config.js");

const ScratchProducts = require("./models/scratchProducts.js");

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

async function productMatching(brands, projectId) {
    try {

        console.log("Starting product matching for brand:", brands.join(", "), "and projectId:", projectId);

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
                sku: { [Op.in]: brands },
                projectId: projectId
            },
            // limit: 1,
            raw: true,
            attributes: ['title', 'url', 'brand', 'sku', 'category', 'images', 'attributes', 'price', 'mrp']
        });

        const brand = sourceProducts[0].brand;

        console.log("Brand: ", sourceProducts[0].brand, "Source products count:", sourceProducts.length);

        let retryCount = 0;

        const outputFilePath = `products_matched_final_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const errorFilePath = `products_matching_errors_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const matchedFilePath = `products_matched_${sourceProducts[0].brand.replace(/\s+/g, "_")}_${projectId}_${Date.now()}.json`;
        const emptyFilePath = `emptyFile.json`

        for (var x = 0; x < sourceProducts.length; x++) {

            const sourceProduct = sourceProducts[x];

            const url = `https://www.nahdionline.com/en-sa/search?query=${encodeURIComponent(sourceProduct.title)}`;

            console.log(x, sourceProduct.title, url);

            const page = await browser.newPage();
            await page.authenticate({
                username: "kqahvuvn-rotate",
                password: "22suvhg9seb1"
            });

            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            } catch (err) {
                console.error("Error navigating to URL:", err);
                retryCount++;
                if (retryCount >= 3) {
                    console.error("Max retries reached for source product:", sourceProduct.title);
                    await appendToFile(errorFilePath, {
                        sourceProduct: sourceProduct,
                        error: "Max retries reached"
                    });
                    await page.close();
                    continue; // Skip to the next source product
                } else {
                    x = x - 1; // Decrement x to retry the current source product
                    await page.close();
                    continue; // Skip to the next source product
                }

            }

            const response = await page.content();

            const $ = cheerio.load(response);

            const doc = new dom().parseFromString($.xml(), 'text/xml');

            let productLinks = xpath.select("//a[@class='flex h-full flex-col']", doc).map(itm => "https://www.nahdionline.com" + itm.getAttribute("href"));

            if (productLinks.length === 0 || productLinks.length > 0) {
                try {

                    const url = `https://www.nahdionline.com/en-sa/search?query=${encodeURIComponent(sourceProduct.title)}&refinementList%5Bmanufacturer%5D%5B0%5D=تيكنوم`;

                    console.log("Retrying with Arabic URL:", url);

                    try {
                        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                    } catch (err) {
                        console.error("Error navigating to Arabic URL:", err);
                        retryCount++;

                        if (retryCount >= 3) {
                            console.error("Max retries reached for source product:", sourceProduct.title);
                            await appendToFile(errorFilePath, {
                                sourceProduct: sourceProduct,
                                error: "Max retries reached"
                            });
                            await page.close();
                            continue; // Skip to the next source product
                        } else {
                            x = x - 1; // Decrement x to retry the current source product
                            await page.close();
                            continue; // Skip to the next source product
                        }


                    }

                    const response = await page.content();

                    const $ = cheerio.load(response);

                    const doc = new dom().parseFromString($.xml(), 'text/xml');

                    const productLinksArab = xpath.select("//a[@class='flex h-full flex-col']", doc).map(itm => "https://www.nahdionline.com" + itm.getAttribute("href"));

                    if (productLinksArab.length > 0) {
                        productLinks = productLinks.concat(productLinksArab);
                    }

                } catch (err) {
                    console.error("Error fetching product links:", err);
                    await appendToFile(errorFilePath, {
                        sourceProduct: sourceProduct,
                        error: err.message
                    });
                    continue; // Skip to the next source product if there's an error
                }

            }

            await page.close();

            if (productLinks.length === 0) {
                console.log("No products found for:", sourceProduct.title);

                await appendToFile("products_matching_errors.json", {
                    sourceProduct: sourceProduct,
                    error: "No products found"
                });

                continue; // Skip to the next source product if no products found
            }

            console.log("Found products:", productLinks.length);

            const productBatches = [];
            try {
                // Process each product link
                const productPage = await browser.newPage();

                for (let i = 0; i < productLinks.length; i++) {
                    const link = productLinks[i];
                    console.log("Processing link:", link);

                    await productPage.authenticate({
                        username: "kqahvuvn-rotate",
                        password: "22suvhg9seb1"
                    });

                    await productPage.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });

                    const productResponse = await productPage.content();

                    const $ = cheerio.load(productResponse);

                    const doc = new dom().parseFromString($.xml(), "text/xml");

                    const category = xpath.select("//ul[@class='flex items-center text-custom-xs font-semibold text-gray ']/li", doc)?.map(itm => itm.textContent).join(" > ");
                    const brand = xpath.select("//div[@class='flex items-center space-x-2 empty:hidden rtl:space-x-reverse']", doc)?.[0]?.textContent;
                    const title = xpath.select("//h1", doc)?.[0]?.textContent;
                    const price = xpath.select("//div[@class='text-primary-red']", doc)?.[0]?.textContent;
                    const mrp = xpath.select("//span[@class='font-montserrat']", doc)?.[0]?.textContent
                    const express = xpath.select("//div[@class='ms-1 flex min-w-fit flex-row']/img", doc).length > 0 ? true : false;
                    const description = xpath.select("//div[@class='pdp-about-section']", doc);
                    const totalRating = xpath.select("//span[@class='flex items-center gap-2 text-2xl font-semibold']", doc)?.[0]?.textContent;
                    const totalReview = xpath.select("//span[@class='hidden text-xl lg:block']", doc)?.[0]?.textContent;
                    // console.log(xpath.select("//img[@class='relative h-full w-full object-contain transition duration-300 ease-in-out group-hover:scale-105']", doc).length)
                    const images = xpath.select("//img[@class='relative h-full w-full object-contain transition duration-300 ease-in-out group-hover:scale-105']", doc).map(itm => "https://www.nahdionline.com" + itm.getAttribute("srcset"))
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
                await productPage.close();

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
                        data: jsonBody
                    };

                    const matchResponse = await axios.request(config);

                    matchData = matchData.concat(matchResponse.data);

                }
            } catch (error) {
                console.log(error);
                console.error("Error matching products:", JSON.stringify(error.response.data));

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

        if (fs.existsSync(outputFilePath)) {
            fs.unlinkSync(outputFilePath);
        }

        if (fs.existsSync(errorFilePath)) {
            fs.unlinkSync(errorFilePath);
        }

        if (fs.existsSync(matchedFilePath)) {
            fs.unlinkSync(matchedFilePath);
        }
        // }

        await browser.close();


    } catch (err) {
        console.error("Error:", err);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const config = require("./config.json");
const { Op } = require('sequelize');

app.post('/product-matching', async (req, res) => {
    const { brand, projectId } = req.body;
    console.log(brand)
    if (!brand || brand.length == 0 || !projectId) {
        return res.status(400).json({ error: "Brand and projectId are required parameters." });
    }

    try {

        res.status(200).json({ message: "Product matching started successfully." });

        await productMatching(brand, projectId);

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

app.listen("6000", () => {
    console.log("Server is running on port 6000");
});