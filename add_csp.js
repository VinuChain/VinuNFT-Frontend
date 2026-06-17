const { createHash } = require("crypto");
const { Parser } = require("htmlparser2");
const fs = require("fs");
const path = require("path");

const TARGET_FOLDER = path.join(path.resolve(), "public");

function getHtmlFiles() {
    // Iterate recursively through the directory and return all HTML files

    const walk = (dir) => {
        let results = [];
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
            file = path.join(dir, file);
            const stat = fs.statSync(file);
            if (stat && stat.isDirectory()) {
                results = results.concat(walk(file));
            } else {
                if (file.endsWith(".html")) {
                    results.push(file);
                }
            }
        });
        return results;
    };

    return walk(TARGET_FOLDER);
}

function computeHash(text) {
    return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}
// Return an array of hashes for <inputFilePath> file and the content of all instances of <tagName> tag
function getShaFromTags(inputFilePath, tagName) {
    console.log(`Getting '<${tagName}>' from ${inputFilePath}`);
    try {
        const fileContents = fs.readFileSync(inputFilePath, {
            encoding: "utf-8",
        });
        let hashes = [];

        let inScriptElement = false;

        const parser = new Parser(
            {
                onopentag: (name, _) => {
                    if (name === tagName) inScriptElement = true;
                },
                ontext: (text) => {
                    if (inScriptElement) {
                        hashes.push(computeHash(text));
                    }
                },
                onclosetag: (tagname) => {
                    if (tagname === "script") inScriptElement = false;
                },
            },
            { decodeEntities: true }
        );

        parser.write(fileContents);
        parser.end();

        let uniqueHashes = [...new Set(hashes)];

        return uniqueHashes;
    } catch (err) {
        console.error(
            `Could not retrieve '<${tagName}>' from ${inputFilePath}`
        );
        throw err;
    }
}

// Bridge RPC endpoints and IPFS gateway required for connect-src.
// Update this list when new chains are added to BRIDGE_EVM_CHAINS in
// src/common/wanbridge.js, or when the IPFS gateway changes in src/config.js.
const CONNECT_SRC_ORIGINS = [
    "https://rpc.vinuchain.org",           // VinuChain mainnet RPC (src/config.js)
    "https://gateway.pinata.cloud",        // IPFS image gateway (src/config.js)
    "https://bridge-api.wanchain.org",     // WanBridge API (src/common/wanbridge.js)
    "https://bsc-dataseed.binance.org",    // BNB Chain RPC
    "https://ethereum-rpc.publicnode.com", // Ethereum RPC
    "https://polygon-rpc.com",             // Polygon RPC
    "https://arb1.arbitrum.io",            // Arbitrum RPC
    "https://api.avax.network",            // Avalanche C-Chain RPC
    "https://mainnet.base.org",            // Base RPC
    "https://mainnet.optimism.io",         // OP Mainnet RPC
    "https://gwan-ssl.wandevs.org:56891",  // Wanchain RPC
];

function addHashesToHtmlFile(inputFilePath, hashes) {
    // Add the hashes to the file's Content Security tag

    const template = "script-src &#x27;self&#x27;";

    // Read the file
    let fileContents = fs.readFileSync(inputFilePath, { encoding: "utf-8" });

    const newHashes = hashes.join(" ");
    const connectSrc = `'self' ${CONNECT_SRC_ORIGINS.join(" ")}`;
    // Replace the bare script-src placeholder with the full expanded policy.
    // All other directives are prepended; sha256 hashes are appended to script-src.
    const newCsp =
        `default-src 'self'; ` +
        `object-src 'none'; ` +
        `base-uri 'self'; ` +
        `frame-ancestors 'self'; ` +
        `img-src 'self' data: https:; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        `frame-src 'self'; ` +
        `connect-src ${connectSrc}; ` +
        `script-src 'self' ${newHashes}`;

    // Replace the CSP tag
    fileContents = fileContents.replace(template, newCsp);

    //console.log(fileContents.slice(0, 1000)); // Just to check the changes before writing the file

    //return

    // Write the file back
    fs.writeFileSync(inputFilePath, fileContents, { encoding: "utf-8" });
}

// The list of all hashes for inserting later via `gatsby-plugin-csp` settings
let scriptHashes = [];
// Iterates through the list of HTML files to calculate all hashes
// Note, I omitted the body of `getHtmlFiles()` method
getHtmlFiles(TARGET_FOLDER).forEach((file) => {
    const hashes = getShaFromTags(file, "script");
    addHashesToHtmlFile(file, hashes);
});

console.log("Done!");
