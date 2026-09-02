const { createHash } = require("crypto");
const { Parser } = require("htmlparser2");
const fs = require("fs");
const path = require("path");

// public/ is what `gatsby build` writes. On Vercel the Gatsby builder plugin
// runs in onPostBuild — inside `gatsby build`, so before this script — and
// hardlinks (or, on failure, copies) public/ into .vercel/output/static, which
// is the directory that actually ships. Walking both is correct either way,
// and re-processing a hardlink is a no-op because CSP_META_CONTENT matches an
// already-expanded policy as well as the bare seed.
const TARGET_FOLDERS = [
    path.join(path.resolve(), "public"),
    path.join(path.resolve(), ".vercel", "output", "static"),
].filter((folder) => fs.existsSync(folder));

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

    return TARGET_FOLDERS.flatMap(walk);
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

// IPFS gateway origins are read out of src/config.js rather than repeated here.
// The app falls back through every configured gateway, so a hard-coded list
// that trails config silently blocks the fallbacks it is meant to permit —
// which is exactly what happened when the fallback gateways were added.
function ipfsGatewayOrigins() {
    const config = fs.readFileSync(
        path.join(path.resolve(), "src", "config.js"),
        { encoding: "utf-8" }
    );
    const block = config.match(/ipfsGateways:\s*\[([\s\S]*?)\]/);
    if (!block) {
        throw new Error(
            "add_csp: could not read ipfsGateways from src/config.js"
        );
    }
    const origins = [...block[1].matchAll(/"(https:\/\/[^"]+)"/g)].map(
        (match) => new URL(match[1]).origin
    );
    if (origins.length === 0) {
        throw new Error("add_csp: ipfsGateways in src/config.js is empty");
    }
    return [...new Set(origins)];
}

// Bridge RPC endpoints required for connect-src. IPFS gateways are appended
// from src/config.js by ipfsGatewayOrigins(). Update this list when new chains
// are added to BRIDGE_EVM_CHAINS in src/common/wanbridge.js.
const CONNECT_SRC_ORIGINS = [
    "https://rpc.vinuchain.org", // VinuChain mainnet RPC (src/config.js)
    "https://bridge-api.wanchain.org", // WanBridge API (src/common/wanbridge.js)
    "https://bsc-dataseed.binance.org", // BNB Chain RPC
    "https://ethereum-rpc.publicnode.com", // Ethereum RPC
    "https://polygon-rpc.com", // Polygon RPC
    "https://arb1.arbitrum.io", // Arbitrum RPC
    "https://api.avax.network", // Avalanche C-Chain RPC
    "https://mainnet.base.org", // Base RPC
    "https://mainnet.optimism.io", // OP Mainnet RPC
    "https://gwan-ssl.wandevs.org:56891", // Wanchain RPC
    // ENS reverse lookup. ethers 5's AlchemyProvider resolves mainnet to this
    // host; ethers 6 moved to eth-mainnet.g.alchemy.com, so the deferred v6
    // migration has to change this entry or every ENS name stops resolving.
    "https://eth-mainnet.alchemyapi.io",
];

// The whole `content=` value of the CSP meta tag, whether it still holds the
// `script-src 'self'` seed from Wrapper.js or an already-expanded policy from
// an earlier run. Matching only the seed made this script silently do nothing
// on a warm build: Gatsby reuses the page HTML it already wrote (seed gone)
// while re-emitting the bundle, so `___chunkMapping` and
// `___webpackCompilationHash` changed underneath a policy that still pinned the
// previous build's hashes and every page shipped unable to boot itself.
const CSP_META_CONTENT =
    /(<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content=")([^"]*)(")/i;

function addHashesToHtmlFile(inputFilePath, hashes) {
    // Add the hashes to the file's Content Security tag

    // Read the file
    let fileContents = fs.readFileSync(inputFilePath, { encoding: "utf-8" });

    const newHashes = hashes.join(" ");
    const connectSrc = `'self' ${[
        ...CONNECT_SRC_ORIGINS,
        ...ipfsGatewayOrigins(),
    ].join(" ")}`;
    // Replace the bare script-src placeholder with the full expanded policy.
    // All other directives are prepended; sha256 hashes are appended to script-src.
    const newCsp =
        `default-src 'self'; ` +
        `object-src 'none'; ` +
        `base-uri 'self'; ` +
        `frame-ancestors 'self'; ` +
        // blob: is required: token images are fetched with a byte cap and
        // handed to <img> via URL.createObjectURL, so without it every image
        // NFT is blocked by the policy. The gateway origins replace a bare
        // `https:`, which let a minted NFT body reference an image on any host
        // and beacon every viewer's IP and User-Agent to the minter — the same
        // threat src/common/ipfs.js closed for the media path. Deliberate
        // content-policy change: a markdown NFT pointing at an arbitrary https
        // image no longer loads it.
        `img-src 'self' data: blob: ${ipfsGatewayOrigins().join(" ")}; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        `frame-src 'self'; ` +
        // No <form> in this app posts anywhere, and form-action does not
        // inherit from default-src, so without it injected markup could still
        // submit somewhere off-origin.
        `form-action 'none'; ` +
        `connect-src ${connectSrc}; ` +
        `script-src 'self' ${newHashes}`;

    // Replace the CSP tag. Gatsby also emits slice fragments under
    // public/_gatsby/ that are stitched into pages and carry no meta tag of
    // their own; they are not documents, so they are skipped rather than
    // treated as a broken page.
    if (!CSP_META_CONTENT.test(fileContents)) {
        return false;
    }
    fileContents = fileContents.replace(
        CSP_META_CONTENT,
        (_match, before, _old, after) => `${before}${newCsp}${after}`
    );

    //console.log(fileContents.slice(0, 1000)); // Just to check the changes before writing the file

    //return

    // Write the file back
    fs.writeFileSync(inputFilePath, fileContents, { encoding: "utf-8" });
    return true;
}

// The list of all hashes for inserting later via `gatsby-plugin-csp` settings
let scriptHashes = [];
// Iterates through the list of HTML files to calculate all hashes
// Note, I omitted the body of `getHtmlFiles()` method
let pagesWritten = 0;
getHtmlFiles().forEach((file) => {
    const hashes = getShaFromTags(file, "script");
    if (addHashesToHtmlFile(file, hashes)) pagesWritten += 1;
});

if (pagesWritten === 0) {
    throw new Error(
        "add_csp: no page carried a Content-Security-Policy meta tag — the build shipped no policy at all"
    );
}

console.log(`Done! (${pagesWritten} pages)`);
