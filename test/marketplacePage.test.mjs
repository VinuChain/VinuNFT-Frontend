import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { ethers } from "ethers";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    appConfig as config,
} from "./helpers/browserHarness.mjs";

// tsx CJS-interop, as in browserHarness.mjs.
const unwrap = (mod) => mod.default?.default ?? mod.default ?? mod;
const { v1 } = unwrap(await import("../src/common/abi.js"));
const { settlementBreakdown } = unwrap(
    await import("../src/common/settlement.js")
);
const { rowMatchesFilters, LISTINGS_PAGE_SIZE } = unwrap(
    await import("../src/common/marketplaceDiscovery.js")
);

const PAGE_SIZE = LISTINGS_PAGE_SIZE ?? 12;

const ifaces = {
    text: new ethers.utils.Interface(v1.text),
    image: new ethers.utils.Interface(v1.image),
    marketplace: new ethers.utils.Interface(v1.marketplace),
    erc20: new ethers.utils.Interface([
        "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]),
};

const HEAD_HEX = "0xe09b34";
const HEAD = parseInt(HEAD_HEX, 16);
const TEXT = config.contractAddresses.v1.text;
const MARKETPLACE = config.contractAddresses.v1.marketplace;
const WVC = config.tokens.wvc.address;
const USDT = config.tokens.usdt.address;
const UNKNOWN_TOKEN = ethers.utils.getAddress(`0x${"de".repeat(20)}`);
const ZERO = ethers.constants.AddressZero;

const ALICE = "0x12BD0b15D5010De455DCe7944265Fe1D35a84023";
const BOB = "0x90e839B02e0285bf3dC52FaeB96a967352e4f2f4";
const CAROL = "0xf10f35Cc6c326F5d7C79Ecab22c2297ebCc87A0b";

const wvc = (n) => ethers.utils.parseUnits(String(n), 18);
const usdt = (n) => ethers.utils.parseUnits(String(n), 6);

const PLATFORM_FEE_BPS = 500;
const ROYALTY_BPS = 1000;

function rawLog(which, address, name, values, blockNumber, logIndex = 0) {
    const iface = ifaces[which];
    const { data, topics } = iface.encodeEventLog(iface.getEvent(name), values);
    return {
        address: address.toLowerCase(),
        topics,
        data,
        blockNumber: ethers.utils.hexValue(blockNumber),
        transactionHash: `0x${String(blockNumber * 10 + logIndex).padStart(
            64,
            "0"
        )}`,
        transactionIndex: "0x0",
        logIndex: ethers.utils.hexValue(logIndex),
        blockHash: `0x${"ab".repeat(32)}`,
        removed: false,
    };
}

const mint = (tokenId, to, units, block) =>
    rawLog("text", TEXT, "TransferSingle", [to, ZERO, to, tokenId, units], block);

const listed = (tokenId, seller, listingId, units, token, price, block) =>
    rawLog(
        "marketplace",
        MARKETPLACE,
        "TokenListed",
        [TEXT, tokenId, seller, listingId, units, token, price],
        block
    );

const purchased = (tokenId, listingId, units, token, price, block) =>
    rawLog(
        "marketplace",
        MARKETPLACE,
        "TokenPurchased",
        [TEXT, tokenId, ALICE, BOB, listingId, units, token, price],
        block
    );

// ---------------------------------------------------------------------------
// Fixture A: every listing state the page has to distinguish, plus two sales
// in two payment tokens.
// ---------------------------------------------------------------------------

const FULFILLABLE_ID = 3; // 5 held, 2 listed
const SHORT_ID = 5; // 1 held, 4 listed
const UNKNOWN_BALANCE_ID = 9; // never transferred, so the fold knows nothing
const UNPRICED_ID = 11; // priced in an ERC-20 outside config.tokens
const WVC_SOLD_ID = 21;
const USDT_SOLD_ID = 23;

const MIXED_LOGS = [
    mint(FULFILLABLE_ID, ALICE, 5, 3000000),
    listed(FULFILLABLE_ID, ALICE, 0, 2, WVC, wvc(7), 3000001),
    mint(SHORT_ID, ALICE, 1, 3000002),
    listed(SHORT_ID, ALICE, 0, 4, WVC, wvc(3), 3000003),
    listed(UNKNOWN_BALANCE_ID, ALICE, 0, 1, WVC, wvc(5), 3000004),
    listed(UNPRICED_ID, BOB, 0, 1, UNKNOWN_TOKEN, wvc(1), 3000005),
    mint(WVC_SOLD_ID, ALICE, 10, 3000010),
    listed(WVC_SOLD_ID, ALICE, 0, 10, WVC, wvc(4), 3000011),
    purchased(WVC_SOLD_ID, 0, 2, WVC, wvc(4), 3000012),
    mint(USDT_SOLD_ID, ALICE, 1, 3000013),
    listed(USDT_SOLD_ID, ALICE, 0, 1, USDT, usdt(2), 3000014),
    purchased(USDT_SOLD_ID, 0, 1, USDT, usdt(2), 3000015),
];

/** The split each sale actually produced, recomputed here rather than restated. */
function saleSplit(total) {
    const platformFee = total.mul(PLATFORM_FEE_BPS).div(10000);
    const remainder = total.sub(platformFee);
    return settlementBreakdown({
        total,
        platformFeeBps: PLATFORM_FEE_BPS,
        royaltyAmount: remainder.mul(ROYALTY_BPS).div(10000),
        royaltyReceiver: ALICE,
    });
}

const SALES = [
    { token: WVC, total: wvc(4).mul(2), block: 3000012, logIndex: 0 },
    { token: USDT, total: usdt(2), block: 3000015, logIndex: 0 },
];

/** Receipts carrying exactly the legs the derivation predicts. */
const RECEIPTS = Object.fromEntries(
    SALES.map((sale) => {
        const split = saleSplit(sale.total);
        const legs = [split.platformFee, split.creatorFee, split.sellerProceeds]
            .filter((leg) => leg.gt(0))
            .map((value, i) =>
                rawLog(
                    "erc20",
                    sale.token,
                    "Transfer",
                    [BOB, ALICE, value],
                    sale.block,
                    i + 10
                )
            );
        const hash = `0x${String(sale.block * 10 + sale.logIndex).padStart(
            64,
            "0"
        )}`;
        // A full receipt: ethers treats one without a blockHash as not yet
        // mined and polls forever, which is a hung page, not a failed read.
        return [
            hash,
            {
                to: MARKETPLACE,
                from: BOB,
                contractAddress: null,
                transactionHash: hash,
                transactionIndex: "0x0",
                gasUsed: "0x5208",
                cumulativeGasUsed: "0x5208",
                effectiveGasPrice: "0x3b9aca00",
                logsBloom: `0x${"00".repeat(256)}`,
                blockHash: `0x${"ab".repeat(32)}`,
                blockNumber: ethers.utils.hexValue(sale.block),
                status: "0x1",
                type: "0x0",
                logs: legs.map((log) => ({
                    ...log,
                    transactionHash: hash,
                    blockHash: `0x${"ab".repeat(32)}`,
                })),
            },
        ];
    })
);

// ---------------------------------------------------------------------------
// Fixture B: enough listings that a page boundary exists at all.
// ---------------------------------------------------------------------------

const MANY_COUNT = 40;
const MANY_LOGS = Array.from({ length: MANY_COUNT }, (_, i) => {
    const tokenId = i + 1;
    return [
        mint(tokenId, ALICE, 5, 3100000 + i * 2),
        listed(tokenId, ALICE, 0, 1, WVC, wvc(tokenId), 3100001 + i * 2),
    ];
}).flat();

// ---------------------------------------------------------------------------
// Chain stub: eth_call keyed on target, selector, arguments AND block tag.
// ---------------------------------------------------------------------------

function callAnswer(body, misses) {
    const [call, blockTag] = body.params;
    const to = String(call.to ?? "").toLowerCase();
    const data = String(call.data ?? "");

    if (to === MARKETPLACE.toLowerCase()) {
        const fn = ifaces.marketplace.getFunction("platformFeePercentage");
        if (data.startsWith(ifaces.marketplace.getSighash(fn))) {
            // A historical read: the current rate must never stand in for it.
            assert.notEqual(
                blockTag,
                "latest",
                "the fee rate for a past sale must be read at that sale's block"
            );
            return ifaces.marketplace.encodeFunctionResult(fn, [
                PLATFORM_FEE_BPS,
            ]);
        }
    }

    if (to === TEXT.toLowerCase()) {
        const decoded = tryDecode(ifaces.text, data);
        if (decoded?.name === "authorOf") {
            // Deliberately not the seller: creator and seller are different
            // people and the card must not conflate them.
            return ifaces.text.encodeFunctionResult("authorOf", [CAROL]);
        }
        if (decoded?.name === "textURI") {
            const id = Number(decoded.args[0]);
            return ifaces.text.encodeFunctionResult("textURI", [
                id === FULFILLABLE_ID
                    ? "data:text/markdown,# hi"
                    : "data:text/plain,hi",
            ]);
        }
        if (decoded?.name === "royaltyInfo") {
            assert.notEqual(
                blockTag,
                "latest",
                "the royalty for a past sale must be read at that sale's block"
            );
            const base = ethers.BigNumber.from(decoded.args[1]);
            return ifaces.text.encodeFunctionResult("royaltyInfo", [
                ALICE,
                base.mul(ROYALTY_BPS).div(10000),
            ]);
        }
    }

    misses.push(`${to}:${data.slice(0, 10)}`);
    return `0x${"0".repeat(64)}`;
}

function tryDecode(iface, data) {
    try {
        const fragment = iface.getFunction(data.slice(0, 10));
        return { name: fragment.name, args: iface.decodeFunctionData(fragment, data) };
    } catch (e) {
        return null;
    }
}

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

async function openMarketplace({ logs = MIXED_LOGS, failLogs = false } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const misses = [];
    const counts = { eth_getLogs: 0 };
    const chain = { head: HEAD };

    await routeOffline(page, origin, {
        rpc: {
            eth_blockNumber: () => ethers.utils.hexValue(chain.head),
            eth_call: (body) => callAnswer(body, misses),
            eth_getTransactionReceipt: (body) =>
                RECEIPTS[body.params[0]] ?? null,
            eth_getLogs: (body) => {
                counts.eth_getLogs += 1;
                const { address, fromBlock, toBlock } = body.params[0];
                const from = parseInt(fromBlock, 16);
                const to = parseInt(toBlock, 16);
                return logs.filter((log) => {
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
        await page.route("**://**", async (route) => {
            const url = route.request().url();
            if (!url.includes("rpc.vinuchain.org")) return route.fallback();
            const body = JSON.parse(route.request().postData() || "{}");
            if (body.method === "eth_getLogs") return route.abort();
            return route.fallback();
        });
    }

    await page.goto(`${origin}/marketplace/`, { waitUntil: "domcontentloaded" });
    await page
        .waitForFunction(
            () => !/Indexing every marketplace event/.test(document.body.textContent ?? ""),
            { timeout: 60000 }
        )
        .catch(() => {});
    await page.waitForTimeout(1500);

    return { page, context, misses, counts, chain };
}

const cardFor = (page, tokenId) =>
    page.locator(`article.marketplace-listing`, {
        has: page.locator(`a[href="/nft?type=text&id=${tokenId}"]`),
    });

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test(
    "listings are paged, with a stated total and a way to reach the rest",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace({ logs: MANY_LOGS });
        try {
            assert.equal(
                await page.locator("article.marketplace-listing").count(),
                PAGE_SIZE,
                "the page must not render every row it holds"
            );
            const body = () => page.textContent("main");
            assert.match(
                await body(),
                new RegExp(`Showing ${PAGE_SIZE} of ${MANY_COUNT}`)
            );

            const more = page.getByRole("button", { name: "Load more" });
            assert.equal(await more.count(), 1);
            await more.click();
            await page.waitForTimeout(200);
            assert.equal(
                await page.locator("article.marketplace-listing").count(),
                PAGE_SIZE * 2
            );

            while ((await more.count()) > 0) {
                await more.click();
                await page.waitForTimeout(200);
            }
            assert.equal(
                await page.locator("article.marketplace-listing").count(),
                MANY_COUNT,
                "every indexed listing must be reachable"
            );
            assert.match(
                await body(),
                new RegExp(`Showing ${MANY_COUNT} of ${MANY_COUNT}`)
            );
        } finally {
            await context.close();
        }
    }
);

// ---------------------------------------------------------------------------
// Price, format, supply, creator, availability
// ---------------------------------------------------------------------------

test(
    "a multi-unit listing states the per-unit price and the lot total",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace();
        try {
            const card = await cardFor(page, FULFILLABLE_ID).textContent();
            assert.match(card, /per unit/i, "a bare price reads as the lot price");
            assert.match(card, /7\.0 WVC/);
            // 2 units at 7 WVC costs 14 WVC (Marketplace.sol charges price x amount).
            assert.match(card, /14\.0 WVC/);
        } finally {
            await context.close();
        }
    }
);

test(
    "a card carries the token's format, supply and creator",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace();
        try {
            const card = await cardFor(page, FULFILLABLE_ID).textContent();
            assert.match(card, /text\/markdown/);
            // Supply is every unit in existence (5 minted), not the 2 listed.
            assert.match(card, /Supply5/);
            assert.match(card, new RegExp(CAROL.slice(0, 8), "i"));
        } finally {
            await context.close();
        }
    }
);

test(
    "the three availability states are distinguished, not collapsed into one",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace();
        try {
            const states = await page.$$eval(
                ".marketplace-listing__availability",
                (els) => els.map((e) => e.textContent.trim())
            );
            assert.equal(
                new Set(states).size,
                3,
                `a known-short seller is not an unchecked one: ${JSON.stringify(states)}`
            );
            assert.match(
                await cardFor(page, SHORT_ID).textContent(),
                /Seller holds only 1 of 4/
            );
            assert.match(
                await cardFor(page, UNKNOWN_BALANCE_ID).textContent(),
                /Seller balance unavailable/
            );
            assert.match(
                await cardFor(page, FULFILLABLE_ID).textContent(),
                /Fulfillable/
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a listing in an unrecognised token is shown unpriced, not dropped",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace();
        try {
            const card = cardFor(page, UNPRICED_ID);
            assert.equal(await card.count(), 1, "the listing exists on chain");
            assert.match(
                await card.textContent(),
                /unavailable \(unrecognised token\)/
            );
            assert.match(
                await card.textContent(),
                new RegExp(UNKNOWN_TOKEN.slice(0, 8), "i")
            );
        } finally {
            await context.close();
        }
    }
);

// ---------------------------------------------------------------------------
// Search, filters, freshness
// ---------------------------------------------------------------------------

test(
    "search finds a token id exactly and a seller by prefix",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace();
        try {
            const box = page.getByPlaceholder("Token id or 0x seller");
            assert.equal(await box.count(), 1);

            await box.fill(String(FULFILLABLE_ID));
            await page.waitForTimeout(200);
            assert.equal(
                await page.locator("article.marketplace-listing").count(),
                1
            );
            assert.equal(await cardFor(page, FULFILLABLE_ID).count(), 1);

            await box.fill(BOB.slice(0, 8));
            await page.waitForTimeout(200);
            assert.equal(await cardFor(page, UNPRICED_ID).count(), 1);
            assert.equal(
                await page.locator("article.marketplace-listing").count(),
                1,
                "a seller prefix must not match unrelated sellers"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "the fulfillable filter agrees with the module every other consumer uses",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace();
        try {
            await page
                .getByRole("checkbox", { name: "Fulfillable only" })
                .check();
            await page.waitForTimeout(200);

            const rendered = await page.$$eval(
                "article.marketplace-listing a[href^='/nft?type=text']",
                (els) =>
                    els.map((e) => Number(new URL(e.href).searchParams.get("id")))
            );

            // Recomputed here from the same rows, not restated as a literal:
            // an unknown balance is unknown availability, which rowMatchesFilters
            // shows and labels rather than hides.
            const rows = [
                { tokenId: FULFILLABLE_ID, sellerBalance: 5, amount: 2 },
                { tokenId: SHORT_ID, sellerBalance: 1, amount: 4 },
                { tokenId: UNKNOWN_BALANCE_ID, sellerBalance: null, amount: 1 },
                { tokenId: UNPRICED_ID, sellerBalance: null, amount: 1 },
                { tokenId: WVC_SOLD_ID, sellerBalance: 8, amount: 8 },
            ];
            const expected = rows
                .filter((row) => rowMatchesFilters(row, { fulfillableOnly: true }))
                .map((row) => row.tokenId);

            assert.deepEqual(rendered.sort((a, b) => a - b), expected.sort((a, b) => a - b));
        } finally {
            await context.close();
        }
    }
);

test(
    "the view states the block it is current to and can be refreshed",
    { skip: !hasBuild },
    async () => {
        const { page, context, counts, chain } = await openMarketplace();
        try {
            // Freshness is stated, not implied: the eyebrow names the block the
            // listings are current to.
            assert.match(
                await page.textContent("main"),
                new RegExp(`block ${HEAD}`)
            );

            const before = counts.eth_getLogs;
            chain.head = HEAD + 5;
            const refresh = page.getByRole("button", { name: "Refresh" });
            assert.equal(await refresh.count(), 1);
            await refresh.click();
            await page.waitForFunction(
                (block) =>
                    document.body.textContent.includes(`block ${block}`),
                HEAD + 5,
                { timeout: 30000 }
            );

            assert.ok(
                counts.eth_getLogs > before,
                "refresh must re-scan the new blocks, not re-render the old state"
            );
        } finally {
            await context.close();
        }
    }
);

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

test(
    "every rendered figure is per payment token and matches the chain exactly",
    { skip: !hasBuild },
    async () => {
        const { page, context, misses } = await openMarketplace();
        try {
            const figures = await page.$$eval(
                ".marketplace-metric__amount",
                (els) => els.map((e) => e.textContent.trim())
            );

            // Recomputed from the same stub the page read.
            const expected = new Set();
            for (const [symbol, decimals, sale, floor] of [
                ["WVC", 18, SALES[0], wvc(3)],
                ["USDT", 6, SALES[1], null],
            ]) {
                const split = saleSplit(sale.total);
                const fmt = (v) =>
                    `${ethers.utils.formatUnits(v, decimals)} ${symbol}`;
                expected.add(fmt(sale.total));
                expected.add(fmt(split.platformFee));
                expected.add(fmt(split.creatorFee));
                expected.add(fmt(split.sellerProceeds));
                expected.add(
                    fmt(
                        sale.token === WVC
                            ? wvc(4)
                            : usdt(2)
                    )
                );
                if (floor) expected.add(fmt(floor));
            }

            assert.deepEqual(
                new Set(figures),
                expected,
                "a figure the chain does not support is a fabricated one"
            );

            const body = await page.textContent("main");
            assert.match(body, new RegExp(`block ${HEAD}`));
            assert.doesNotMatch(body, /24h|trend|% change|rarity/i);
            assert.deepEqual(misses, [], "an unanswered read reads as zero");
        } finally {
            await context.close();
        }
    }
);

test(
    "a failed scan renders no figure at all, rather than a partial one",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMarketplace({ failLogs: true });
        try {
            assert.equal(
                await page.locator(".marketplace-metric__amount").count(),
                0
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

