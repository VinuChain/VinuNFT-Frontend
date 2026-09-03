import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { ethers } from "ethers";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    chainAnswers,
    answerCall,
    appConfig as config,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

// tsx CJS-interop, as in browserHarness.mjs.
const unwrap = (mod) => mod.default?.default ?? mod.default ?? mod;
const { v1 } = unwrap(await import("../src/common/abi.js"));

const ifaces = {
    text: new ethers.utils.Interface(v1.text),
    marketplace: new ethers.utils.Interface(v1.marketplace),
};

const HEAD_HEX = "0xe09b34";
const HEAD = parseInt(HEAD_HEX, 16);
const TEXT = config.contractAddresses.v1.text;
const MARKETPLACE = config.contractAddresses.v1.marketplace;
const WVC = config.tokens.wvc.address;
const ZERO = ethers.constants.AddressZero;

/**
 * The token the old bounded scan could not reach.
 *
 * `lastTokenId` is 40, so `tokenIdsFromLatest(40, 12)` yields 40..29 and token
 * 3 is never read. Only an index folded from the contract's whole event history
 * can surface it, which is exactly the claim this file exists to check.
 */
const OUTSIDE_WINDOW_ID = 3;
const LAST_TOKEN_ID = 40;
const LISTED_AMOUNT = 2;
const LISTED_PRICE = ethers.utils.parseUnits("7", 18);

function rawLog(which, address, name, values, blockNumber) {
    const iface = ifaces[which];
    const { data, topics } = iface.encodeEventLog(iface.getEvent(name), values);
    return {
        address: address.toLowerCase(),
        topics,
        data,
        blockNumber: ethers.utils.hexValue(blockNumber),
        transactionHash: `0x${String(blockNumber).padStart(64, "0")}`,
        transactionIndex: "0x0",
        logIndex: "0x0",
        blockHash: `0x${"ab".repeat(32)}`,
        removed: false,
    };
}

// A mint of five units to the seller, then a listing of two of them. The mint
// is what gives the fold a seller balance without a single balanceOf call.
const LOGS = [
    rawLog(
        "text",
        TEXT,
        "TransferSingle",
        [TEST_ACCOUNT, ZERO, TEST_ACCOUNT, OUTSIDE_WINDOW_ID, 5],
        3000000
    ),
    rawLog("marketplace", MARKETPLACE, "TokenListed", [
        TEXT,
        OUTSIDE_WINDOW_ID,
        TEST_ACCOUNT,
        0,
        LISTED_AMOUNT,
        WVC,
        LISTED_PRICE,
    ], 3000001),
];

// Every read the *bounded* path would make, answered generously, so a red run
// cannot be blamed on a starved fixture.
const CALL_TABLE = chainAnswers([
    { to: "text", fn: "lastTokenId", returns: [LAST_TOKEN_ID] },
    { to: "image", fn: "lastTokenId", returns: [LAST_TOKEN_ID] },
    {
        to: "text",
        fn: "authorOf",
        args: [OUTSIDE_WINDOW_ID],
        returns: [TEST_ACCOUNT],
    },
]);

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

async function openMarketplace({ failLogs = false } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const counts = { eth_getLogs: 0 };

    await routeOffline(page, origin, {
        rpc: {
            eth_blockNumber: HEAD_HEX,
            eth_call: (body) => answerCall(CALL_TABLE, body),
            eth_getLogs: (body) => {
                counts.eth_getLogs += 1;
                const { address, fromBlock, toBlock } = body.params[0];
                const from = parseInt(fromBlock, 16);
                const to = parseInt(toBlock, 16);
                return LOGS.filter((log) => {
                    const block = parseInt(log.blockNumber, 16);
                    return (
                        log.address === String(address).toLowerCase() &&
                        block >= from &&
                        block <= to
                    );
                });
            },
        },
    });

    if (failLogs) {
        // Registered last, so Playwright matches it first: the scan fails while
        // every other read still succeeds.
        await page.route("**://**", async (route) => {
            const url = route.request().url();
            if (!url.includes("rpc.vinuchain.org")) return route.fallback();
            const body = JSON.parse(route.request().postData() || "{}");
            if (body.method === "eth_getLogs") return route.abort();
            return route.fallback();
        });
    }

    await page.goto(`${origin}/marketplace/`, {
        waitUntil: "domcontentloaded",
    });

    // The scan is ~125 ranges per contract; wait for the page to settle rather
    // than for a fixed time, or the assertion measures the loading state.
    await page
        .waitForFunction(
            () => !/Loading listings/.test(document.body.textContent ?? ""),
            { timeout: 60000 }
        )
        .catch(() => {});

    return { page, context, counts };
}

test(
    "the marketplace lists a token the bounded window could never reach",
    { skip: !hasBuild },
    async () => {
        const { page, context, counts } = await openMarketplace();
        try {
            const card = page.locator(
                `a[href="/nft?type=text&id=${OUTSIDE_WINDOW_ID}"]`
            );
            assert.equal(
                await card.count(),
                1,
                "token 3 is outside the latest-12 window, so only an index-backed page can show it"
            );

            const body = (await page.textContent("main")) ?? "";
            assert.match(body, /7\.0 WVC/);
            assert.match(body, new RegExp(`Amount${LISTED_AMOUNT}`));

            // Freshness is stated, not implied.
            assert.match(body, new RegExp(`block ${HEAD}`));

            console.log(
                `cold /marketplace/ eth_getLogs: ${counts.eth_getLogs}`
            );
            // One chunked pass per contract, not one per token or per filter.
            assert.ok(
                counts.eth_getLogs <= 3 * 130,
                `expected one pass per contract, saw ${counts.eth_getLogs} eth_getLogs`
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a failed scan is reported, never rendered as an empty marketplace",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace({ failLogs: true });
        try {
            const body = (await page.textContent("main")) ?? "";
            assert.doesNotMatch(
                body,
                /No listings/,
                "a failed index scan must not read as a marketplace with nothing for sale"
            );
            assert.equal(
                await page.locator(".notification.is-danger").count(),
                1
            );
        } finally {
            await context.close();
        }
    }
);
