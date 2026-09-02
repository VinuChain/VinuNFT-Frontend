import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    chainAnswers,
    answerCall,
    nftPageAnswers,
    TEST_ACCOUNT,
    installMockWallet,
    connectWallet,
} from "./helpers/browserHarness.mjs";

// Performance budgets. Two rules decide what is asserted and what is only
// printed: gate counted work (bytes on disk, RPC round trips), never wall
// clock, which measures the runner; and set every ceiling from a measurement
// recorded here, never from a number someone remembers.

const PUBLIC_DIR = "public";
const STATS = join(PUBLIC_DIR, "webpack.stats.json");

// Gatsby's chunk groups are the browser-observed load set: app (the scripts in
// index.html) plus the route's own group, which carries the async chunks
// webpack fetches immediately. Reading index.html's <script> tags instead
// reports ~355 KB and misses ~85% of the bytes, including the 1.5 MB chunk
// that ethers pulls in.
const ROUTE_CHUNK = {
    "/": "component---src-pages-index-js",
    "/marketplace/": "component---src-pages-marketplace-js",
    "/activity/": "component---src-pages-activity-js",
    "/address/": "component---src-pages-address-js",
    "/media/": "component---src-pages-media-js",
};

// Measured 2026-09-01 against the build in public/: 10 files, 2,902,695 raw /
// 964,493 gzip on "/", peaking at 972,581 gzip on /activity/. The ceiling is
// that plus ~8%: enough headroom for ordinary churn, tight enough that one
// more top-level dependency of any size trips it. It is a regression budget,
// NOT a statement that ~965 KB of gzipped JS before a single interaction is
// good — it is not, and the cause is `ethers` imported statically at
// src/pages/index.js and src/common/marketplaceDiscovery.js.
const GZIP_BUDGET = 1_050_000;

function weighRoute(path) {
    const stats = JSON.parse(readFileSync(STATS, "utf8"));
    const js = (group) => {
        const found = stats.namedChunkGroups[group];
        assert.ok(found, `webpack.stats.json has no chunk group '${group}'`);
        return found.assets.map((a) => a.name).filter((n) => n.endsWith(".js"));
    };
    const files = [...new Set([...js("app"), ...js(ROUTE_CHUNK[path])])];
    let raw = 0;
    let gzip = 0;
    for (const f of files) {
        const onDisk = join(PUBLIC_DIR, f);
        // Fail rather than skip: a stats entry with no file means a stale or
        // half-written build, and silently weighing fewer files is exactly the
        // vacuous pass this budget exists to prevent.
        assert.ok(existsSync(onDisk), `${f} is named in webpack.stats.json but missing from public/`);
        const bytes = readFileSync(onDisk);
        raw += bytes.length;
        // Gzip on disk, not stats.size: the wire cost is what users pay.
        gzip += gzipSync(bytes, { level: 9 }).length;
    }
    return { files, raw, gzip };
}

for (const path of Object.keys(ROUTE_CHUNK)) {
    test(`bundle: ${path} initial JS stays within budget`, { skip: !hasBuild }, () => {
        const { files, raw, gzip } = weighRoute(path);
        console.log(
            `bundle ${path}: ${files.length} JS files, ${raw} raw, ${gzip} gzip (budget ${GZIP_BUDGET})`
        );
        assert.ok(
            gzip <= GZIP_BUDGET,
            `${path} ships ${gzip} bytes of gzipped JS before any interaction, budget ${GZIP_BUDGET}`
        );
    });
}

// --- request counts ---------------------------------------------------------

let server;
let browser;
let origin;

before(async () => {
    if (!hasBuild) return;
    const { chromium } = await import("playwright");
    ({ server, origin } = await startStaticServer());
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

// routeOffline answers every eth_call with zero, which makes lastTokenId 0 and
// leaves the discovery window empty — a ceiling measured that way counts a
// marketplace that scans nothing. Three tokens exist on chain 207, so that is
// what the stub reports.
const TOKEN_COUNT = 3;
const lastTokenIdAnswers = () =>
    chainAnswers([
        { to: "text", fn: "lastTokenId", returns: [TOKEN_COUNT] },
        { to: "image", fn: "lastTokenId", returns: [TOKEN_COUNT] },
    ]);

/** Open a route and wait until chain traffic stops, counting RPC calls by method. */
async function countRpc(path, { wallet = false, answers = null } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const byMethod = {};
    let total = 0;
    let lastAt = Date.now();
    page.on("request", (r) => {
        if (!r.url().includes("rpc.vinuchain.org") || r.method() !== "POST") return;
        const method = JSON.parse(r.postData() || "{}").method ?? "unknown";
        byMethod[method] = (byMethod[method] ?? 0) + 1;
        total += 1;
        lastAt = Date.now();
    });

    const table = { ...lastTokenIdAnswers(), ...(answers ?? {}) };
    await routeOffline(page, origin, {
        rpc: { eth_call: (body) => answerCall(table, body) },
    });
    if (wallet) await installMockWallet(page, { chain: { answers: table } });
    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    if (wallet) await connectWallet(page);

    // Quiet-period wait: a fixed sleep either truncates the scan or pads every
    // run, and both make the count meaningless.
    const deadline = Date.now() + 40000;
    do {
        await page.waitForTimeout(500);
    } while (Date.now() - lastAt < 2000 && Date.now() < deadline);

    const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const walletCalls = wallet
        ? await page.evaluate(() => window.__walletCalls?.length ?? 0)
        : 0;
    await context.close();
    return { total, byMethod, heap, walletCalls };
}

// Ceilings measured on this build, offline, with the stubs above. They gate the
// shape of the scan, not its speed: the defect class is a change that still
// calls queryFilterChunked but starts a fresh pass per token or per filter,
// which every existing source-text assertion passes.
//
// /media/ is absent on purpose: it is the brand media kit and reads no chain
// state (1 call), so a budget on it would assert nothing. The spec's
// "metadata and media" is the token page, which is what /nft/ measures here.
// Measured 2026-09-01 against the build in public/: / 18, /marketplace/ 12,
// /activity/ 432 (375 eth_getLogs, matching the 376 seen live), /address/ 23,
// /nft/ 300. Budgets are those plus room for ordinary churn.
//
// /marketplace/ and /address/ were re-measured after VN-INDEX-001 pointed both
// at the index: each now pays the same one-pass-per-contract scan /activity/
// pays (375 eth_getLogs over three contracts), instead of a 12-token window
// that could not see most of the marketplace. The budget still gates the SHAPE
// of the scan — 375 is three passes, and the defect class this catches is a
// fresh pass per token or per filter, which would be an order of magnitude
// more. Both routes share one scan within a session; these are cold loads.
//
// Re-measured after VN-MARKET-001/002: /marketplace/ 421, /address/ 424. The
// settlement and format reads those tickets added are O(sales) and O(listed
// tokens), NOT O(blocks), so they contribute ZERO here — routeOffline answers
// eth_getLogs with [], leaving the stub marketplace with no sales and no
// listings. That is why this budget cannot police them; test/indexLoader.test.mjs
// pins their exact counts (8 eth_call, 2 receipts) against the live fixture.
const RPC_CASES = [
    { path: "/", budget: 30 },
    { path: "/marketplace/", budget: 450 },
    { path: "/activity/", budget: 450 },
    { path: `/address/?address=${TEST_ACCOUNT}`, budget: 450 },
    {
        path: "/nft/?type=image&id=1",
        // 300 calls measured, of which 250 are the one chunked history pass
        // over ~2.5M blocks (the ledger's 1500 -> 250 improvement). A per-filter
        // regression multiplies that pass, which is what this catches.
        budget: 330,
        answers: nftPageAnswers({ nftType: "image", uri: "ipfs://bafyexample" }),
    },
];

for (const { path, budget, answers } of RPC_CASES) {
    test(`requests: ${path} stays within its RPC budget`, { skip: !hasBuild }, async () => {
        const { total, byMethod, heap } = await countRpc(path, { answers });
        console.log(
            `rpc ${path}: ${total} calls (budget ${budget}) ${JSON.stringify(byMethod)}` +
                (heap ? `, heap ${heap} bytes` : "")
        );
        assert.ok(
            total <= budget,
            `${path} issued ${total} RPC calls, budget ${budget}: ${JSON.stringify(byMethod)}`
        );
    });
}

test("requests: connecting a wallet costs a bounded number of calls", { skip: !hasBuild }, async () => {
    const { walletCalls, total, byMethod } = await countRpc("/", { wallet: true });
    console.log(
        `wallet connect: ${walletCalls} provider calls, ${total} node calls ${JSON.stringify(byMethod)}`
    );
    assert.ok(
        walletCalls > 0,
        "no provider calls were observed — the connect path did not run, so this measures nothing"
    );
    assert.ok(
        walletCalls <= 40,
        `connecting issued ${walletCalls} provider calls, budget 40`
    );
});

// --- upload: IPFS pinning ---------------------------------------------------

// MEASURED against the LIVE Pinata API, through the real
// src/api/upload-ipfs.js handler — not a stub, not a client-side timing.
// Supplied by the operator who ran it, on or before 2026-09-02; the exact run
// date was not recorded, so it is stated as a bound rather than invented:
//
//     payload      round trip   status
//     1 KB           1951 ms    200
//     256 KB         2233 ms    200
//     2 MB           6123 ms    200
//     metadata       1240 ms    200
//
// 4 uploads, 0 errors. The four test objects were unpinned afterwards. The
// measurement is not repeated here and cannot be: it needs a Pinata credential,
// which this repository does not have and must never contain.
//
// NOT A BUDGET, AND DELIBERATELY NOT GATED. These are third-party wall-clock
// numbers from a service this project neither hosts nor controls; asserting a
// ceiling on them would gate Pinata's day, and the file's own rule at the top
// is to gate counted work and never wall clock. They are recorded so the cost
// of a mint can be reasoned about at all, which until now it could not.
//
// What IS controlled is the COUNT, and the count is what multiplies the numbers
// above. An image mint is image + metadata:
//
//   2 endpoint round trips  — gated in test/journeys.mint.test.mjs, which also
//                             holds a failed mint to reusing the pinned CIDs
//   1 Pinata round trip per endpoint call — gated below
//
// So a typical image mint spends ~1.2 s + ~2.2 s = ~3.4 s in Pinata, and a 2 MB
// image ~6.1 s + ~1.2 s = ~7.4 s. The 6.1 s single call is the figure that has
// to fit inside the host's per-invocation function duration limit, because the
// two calls are two separate invocations.

const UPLOAD_ACTION = { file: "mint-image", json: "mint-metadata" };

test("upload: one accepted upload costs exactly one Pinata round trip", async () => {
    const { ethers } = await import("ethers");
    const { default: handler } = await import("../src/api/upload-ipfs.js");
    const { createUploadMessage, uploadPayloadDigest } = await import(
        "../src/common/uploadIntent.js"
    );

    const wallet = ethers.Wallet.createRandom();
    process.env.PINATA_API_JWT = "test-only-placeholder-not-a-credential";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = wallet.address;

    const payload = { type: "json", metadata: { name: "Perf" } };
    const issuedAt = new Date().toISOString();
    const auth = {
        address: wallet.address,
        issuedAt,
        signature: await wallet.signMessage(
            createUploadMessage({
                address: ethers.utils.getAddress(wallet.address),
                issuedAt,
                chainId: 207,
                action: UPLOAD_ACTION[payload.type],
                digest: uploadPayloadDigest(payload),
            })
        ),
    };

    const realFetch = globalThis.fetch;
    const pinataCalls = [];
    globalThis.fetch = async (url, init) => {
        pinataCalls.push(String(url));
        return { ok: true, status: 200, text: async () => '{"IpfsHash":"QmPerf"}' };
    };

    const res = {
        statusCode: null,
        status(code) { this.statusCode = code; return this; },
        setHeader() {},
        send(body) { this.body = body; return this; },
    };
    const realInfo = console.info;
    console.info = () => {};
    try {
        await handler(
            { method: "POST", headers: {}, socket: { remoteAddress: "203.0.113.9" }, body: { ...payload, auth } },
            res
        );
    } finally {
        globalThis.fetch = realFetch;
        console.info = realInfo;
    }

    assert.equal(res.statusCode, 200, `the upload was rejected, so this counted nothing: ${res.body}`);
    // The budget. Each of these costs 1.2-6.1 s of somebody else's latency, so
    // a handler that retried, or pinned twice for redundancy, would silently
    // double the slowest step of a mint with nothing to notice it.
    assert.deepEqual(pinataCalls, ["https://api.pinata.cloud/pinning/pinJSONToIPFS"]);
});

// --- upload validation ------------------------------------------------------

test("upload validation inspects headers rather than decoding", async () => {
    const { sniffImage } = await import("../src/common/imageSniff.js");
    const { uploadPayloadDigest } = await import("../src/common/uploadIntent.js");

    // A 10 MB PNG, the configured maxIpfsUploadBytes ceiling.
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.write("IHDR", 12);
    bytes.writeUInt32BE(64, 16);
    bytes.writeUInt32BE(64, 20);

    const started = performance.now();
    const sniffed = sniffImage(bytes);
    const sniffMs = performance.now() - started;
    // Times the base64 encode too, because the real upload path encodes the
    // whole file before it digests a slice of it — the encode is the cost.
    const digestStarted = performance.now();
    uploadPayloadDigest({ bytes: bytes.toString("base64").slice(0, 1024) });
    const digestMs = performance.now() - digestStarted;

    // Logged, not gated: wall clock on a shared runner measures the runner.
    console.log(
        `upload validation on 10 MB: sniff ${sniffMs.toFixed(1)}ms, base64+digest ${digestMs.toFixed(1)}ms`
    );
    assert.equal(sniffed.mediaType, "image/png");
    // The property that keeps it cheap, asserted where a timing ceiling would
    // only flake: geometry comes from the header, not from decoding pixels.
    assert.deepEqual([sniffed.width, sniffed.height], [64, 64]);
});
