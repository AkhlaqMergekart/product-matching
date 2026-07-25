const fs = require("fs");

// Reads `filename` (creating it with `[]` if missing), appends `data` (an
// array is concatenated, a single item is pushed if not already present),
// and writes the result back. Fine at this scale (a brand's product list is
// a few hundred items over a handful of paginated calls) — mirrors the same
// pattern index.js uses inline.
function appendToFile(filename, data) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filename)) {
            fs.writeFileSync(filename, JSON.stringify([], null, 2), "utf8");
        }

        fs.readFile(filename, "utf8", (err, fileData) => {
            if (err) return reject(err);

            let arr = JSON.parse(fileData);

            if (Array.isArray(data)) {
                arr = arr.concat(data);
            } else {
                const found = arr.find((itm) => itm === data);
                if (!found) {
                    arr.push(data);
                }
            }

            fs.writeFile(filename, JSON.stringify(arr, null, 2), "utf8", (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    });
}

module.exports = { appendToFile };
