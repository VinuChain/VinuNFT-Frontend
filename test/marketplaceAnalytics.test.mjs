import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ethers } from "ethers";
import * as _analytics from "../src/common/marketplaceAnalytics.js";
import * as _indexer from "../src/common/indexer.js";

// tsx CJS-interop: named exports land on the .default namespace object.
const { marketplaceMetrics } = _analytics.default || _analytics;
const { emptyState, ingest, annotateSale } = _indexer.default || _indexer;

const fixture = JSON.parse(
    fs.readFileSync(new URL("./fixtures-chain207-logs.json", import.meta.url))
);
const abi = (name) =>
    JSON.parse(
        fs.readFileSync(new URL(`../src/abis/${name}.json`, import.meta.url))
    ).abi;

const marketplaceIface = new ethers.utils.Interface(abi("Marketplace"));
const MARKETPLACE = fixture.contracts.marketplace.address;
const TEXT = fixture.contracts.text.address;
const WVC = "0xEd8c5530a0A086a12f57275728128a60DFf04230";
const USDT = "0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41";
const ALICE = "0x12BD0b15D5010De455DCe7944265Fe1D35a84023";
const BOB = "0x90e839B02e0285bf3dC52FaeB96a967352e4f2f4";

const wei = (n) => ethers.utils.parseUnits(String(n), 18).toString();

function rawLog(address, name, values, blockNumber, logIndex = 0) {
    const { data, topics } = marketplaceIface.encodeEventLog(
        marketplaceIface.getEvent(name),
        values
    );
    return {
        address: address.toLowerCase(),
        topics,
        data,
        blockNumber,
        transactionIndex: 0,
        logIndex,
        transactionHash: `0x${String(blockNumber * 100 + logIndex).padStart(
            64,
            "0"
        )}`,
        removed: false,
    };
}

const decode = (logs) =>
    logs.map((log) => {
        const parsed = marketplaceIface.parseLog(log);
        return { ...log, event: parsed.name, args: parsed.args };
    });

function foldFixture() {
    // The complete chain-207 log set: nothing sampled, nothing synthesised.
    // Decoded exactly as `queryFilterChunked` hands them to the fold.
    const ifaces = {
        marketplace: marketplaceIface,
        text: new ethers.utils.Interface(abi("TextNFT")),
        image: new ethers.utils.Interface(abi("ImageNFT")),
    };
    const all = Object.entries(fixture.logs).flatMap(([name, logs]) =>
        logs.flatMap((log) => {
            try {
                const parsed = ifaces[name].parseLog(log);
                return [{ ...log, event: parsed.name, args: parsed.args }];
            } catch (e) {
                return [];
            }
        })
    );
    return ingest(emptyState(), all, {
        address: MARKETPLACE,
        fromBlock: fixture.contracts.marketplace.firstBlock,
        toBlock: fixture.capturedAtBlock,
    });
}

/**
 * The live fee schedule, applied at each sale's own block.
 *
 * 500 bps and a 10% royalty are not guesses: sale 1's own receipt legs are
 * 0.05 / 0.095 / 0.855 on a 1.0 WVC total, so the platform took 5% and the
 * creator took 10% of the 0.95 remainder. The fixture proves its own rates.
 */
function annotateLiveSales(state) {
    let next = state;
    for (const sale of state.sales) {
        const total = ethers.BigNumber.from(sale.price).mul(sale.amount);
        const platformFee = total.mul(500).div(10000);
        const remainder = total.sub(platformFee);
        next = annotateSale(next, sale.id, {
            platformFeeBps: 500,
            royaltyAmount: remainder.mul(1000).div(10000),
            royaltyReceiver: ALICE,
            receiptLegs: fixture.purchaseReceiptLegs[sale.transactionHash],
        });
    }
    return next;
}

// ---------------------------------------------------------------------------
// Reconciliation against the live chain
// ---------------------------------------------------------------------------

test("every money figure reconciles to the two real purchases and their receipts", () => {
    const state = annotateLiveSales(foldFixture());
    const metrics = marketplaceMetrics(state);
    const wvcBucket = metrics.byPaymentToken.wvc;

    // Receipts: 0.095 + 0.05 + 0.855 = 1.0 and 4.75 + 2.5 + 42.75 = 50.0.
    const receiptTotal = Object.values(fixture.purchaseReceiptLegs)
        .flat()
        .reduce(
            (sum, leg) => sum.add(leg.value),
            ethers.BigNumber.from(0)
        );
    assert.equal(receiptTotal.toString(), wei(51));

    assert.equal(wvcBucket.salesCount, 2);
    assert.equal(wvcBucket.unitsSold, 2);
    assert.equal(wvcBucket.volume, wei(51));
    assert.equal(wvcBucket.platformFees, wei(2.55));
    assert.equal(wvcBucket.royalties, wei(4.845));
    assert.equal(wvcBucket.sellerProceeds, wei(43.605));
    assert.equal(wvcBucket.salesMissingSettlement, 0);
    assert.equal(wvcBucket.settlementsReconciled, 2);

    // The three legs are the whole price, not a sample of it.
    assert.equal(
        ethers.BigNumber.from(wvcBucket.platformFees)
            .add(wvcBucket.royalties)
            .add(wvcBucket.sellerProceeds)
            .toString(),
        wvcBucket.volume
    );

    assert.equal(wvcBucket.lastSale.price, wei(50));
    assert.equal(wvcBucket.lastSale.block, 3698029);
    assert.equal(wvcBucket.floorUnitPrice, wei(50));
    assert.equal(wvcBucket.activeListings, 1);

    assert.equal(metrics.buyers, 1);
    assert.equal(metrics.sellers, 1);
    assert.equal(metrics.salesCount, 2);
    assert.equal(metrics.activeListings, 1);
});

test("listings created counts distinct listings, not TokenListed events", () => {
    // Live: seven TokenListed logs carrying two listing ids, because
    // editListing re-emits under the same id. Event cardinality reports 7.
    const state = foldFixture();
    const listedEvents = Object.values(state.events).filter(
        (e) => e.event === "TokenListed"
    );
    assert.equal(listedEvents.length, 7);
    assert.equal(marketplaceMetrics(state).listingsCreated, 2);
});

// ---------------------------------------------------------------------------
// Definition traps that live data cannot expose
// ---------------------------------------------------------------------------

test("volume is SUM(price x amount): a multi-unit sale is not counted once", () => {
    // Both real sales are of one unit, so SUM(price) and SUM(price x amount)
    // agree on chain. This is the only thing that separates them.
    const logs = decode([
        rawLog(
            MARKETPLACE,
            "TokenPurchased",
            [TEXT, 1, ALICE, BOB, 0, 1, WVC, wei(50)],
            100
        ),
        rawLog(
            MARKETPLACE,
            "TokenPurchased",
            [TEXT, 2, ALICE, BOB, 0, 4, WVC, wei(10)],
            101
        ),
        rawLog(
            MARKETPLACE,
            "TokenPurchased",
            [TEXT, 3, ALICE, BOB, 0, 2, WVC, wei(7)],
            102
        ),
    ]);
    const metrics = marketplaceMetrics(
        ingest(emptyState(), logs, {
            address: MARKETPLACE,
            fromBlock: 0,
            toBlock: 200,
        })
    );

    assert.equal(metrics.byPaymentToken.wvc.volume, wei(104));
    assert.equal(metrics.byPaymentToken.wvc.unitsSold, 7);
    assert.equal(metrics.byPaymentToken.wvc.salesCount, 3);
});

test("a second payment token is its own bucket, never added into the first", () => {
    const logs = decode([
        rawLog(
            MARKETPLACE,
            "TokenPurchased",
            [TEXT, 1, ALICE, BOB, 0, 1, WVC, wei(50)],
            100
        ),
        rawLog(
            MARKETPLACE,
            "TokenPurchased",
            [TEXT, 2, ALICE, BOB, 0, 1, USDT, "2000000"],
            101
        ),
    ]);
    const metrics = marketplaceMetrics(
        ingest(emptyState(), logs, {
            address: MARKETPLACE,
            fromBlock: 0,
            toBlock: 200,
        })
    );

    assert.equal(metrics.byPaymentToken.wvc.volume, wei(50));
    assert.equal(metrics.byPaymentToken.usdt.volume, "2000000");
    // No cross-currency aggregate exists at all: there is no price oracle in
    // this product, so a single "total volume" would be fabricated.
    assert.equal(metrics.volume, undefined);
    assert.equal(metrics.floorUnitPrice, undefined);
    assert.equal(metrics.salesCount, 2);
});

test("a sale whose fee split could not be read still counts toward volume", () => {
    const logs = decode([
        rawLog(
            MARKETPLACE,
            "TokenPurchased",
            [TEXT, 1, ALICE, BOB, 0, 1, WVC, wei(50)],
            100
        ),
        rawLog(
            MARKETPLACE,
            "TokenPurchased",
            [TEXT, 2, ALICE, BOB, 0, 1, WVC, wei(10)],
            101
        ),
    ]);
    let state = ingest(emptyState(), logs, {
        address: MARKETPLACE,
        fromBlock: 0,
        toBlock: 200,
    });
    // Only the first sale's historical reads succeeded.
    state = annotateSale(state, state.sales[0].id, {
        platformFeeBps: 500,
        royaltyAmount: 0,
        royaltyReceiver: ethers.constants.AddressZero,
        receiptLegs: [{ value: wei(2.5) }, { value: wei(47.5) }],
    });

    const bucket = marketplaceMetrics(state).byPaymentToken.wvc;
    assert.equal(bucket.volume, wei(60), "both sales are in the volume");
    assert.equal(bucket.salesMissingSettlement, 1);
    assert.equal(
        bucket.platformFees,
        wei(2.5),
        "fees cover only the sale whose split is known"
    );
    assert.equal(bucket.royalties, "0");
    assert.equal(bucket.sellerProceeds, wei(47.5));
});

test("a listing priced in an unrecognised token is counted, never priced or floored", () => {
    const unknown = ethers.utils.getAddress(`0x${"de".repeat(20)}`);
    const logs = decode([
        rawLog(
            MARKETPLACE,
            "TokenListed",
            [TEXT, 1, ALICE, 0, 1, WVC, wei(50)],
            100
        ),
        rawLog(
            MARKETPLACE,
            "TokenListed",
            [TEXT, 2, ALICE, 0, 1, unknown, wei(1)],
            101
        ),
    ]);
    const metrics = marketplaceMetrics(
        ingest(emptyState(), logs, {
            address: MARKETPLACE,
            fromBlock: 0,
            toBlock: 200,
        })
    );

    assert.equal(metrics.activeListings, 2);
    assert.equal(metrics.unpricedActiveListings, 1);
    assert.equal(metrics.byPaymentToken.wvc.floorUnitPrice, wei(50));
    assert.equal(metrics.byPaymentToken.wvc.activeListings, 1);
    assert.equal(Object.keys(metrics.byPaymentToken).length, 1);
});

test("the floor is the lowest UNIT price, and a delisted listing cannot set it", () => {
    const logs = decode([
        rawLog(
            MARKETPLACE,
            "TokenListed",
            [TEXT, 1, ALICE, 0, 3, WVC, wei(50)],
            100
        ),
        // A cheaper lot per unit, but delisted: it is not for sale at any price.
        rawLog(
            MARKETPLACE,
            "TokenListed",
            [TEXT, 2, ALICE, 0, 1, WVC, wei(9)],
            101
        ),
        rawLog(MARKETPLACE, "TokenDelisted", [TEXT, 2, ALICE, 0], 102),
        // 1 unit at 60 costs less than the 3-unit lot at 50, so a lot-price
        // floor would report this one. The stated definition is per unit.
        rawLog(
            MARKETPLACE,
            "TokenListed",
            [TEXT, 3, ALICE, 0, 1, WVC, wei(60)],
            103
        ),
    ]);
    const metrics = marketplaceMetrics(
        ingest(emptyState(), logs, {
            address: MARKETPLACE,
            fromBlock: 0,
            toBlock: 200,
        })
    );

    assert.equal(metrics.byPaymentToken.wvc.floorUnitPrice, wei(50));
    assert.equal(metrics.byPaymentToken.wvc.activeListings, 2);
    assert.equal(metrics.listingsCreated, 3);
});

test("no trend, no average, no cross-currency total is produced", () => {
    // Behavioural, not a grep: the metric object is the whole contract the page
    // renders from, so a fabricated aggregate has to appear here first.
    const metrics = marketplaceMetrics(annotateLiveSales(foldFixture()));
    const forbidden = [
        "trend",
        "change24h",
        "changePercent",
        "averagePrice",
        "medianPrice",
        "totalVolume",
        "volumeUsd",
        "rarity",
    ];
    for (const key of forbidden) {
        assert.equal(
            metrics[key],
            undefined,
            `${key} has no exact definition here and must not be computed`
        );
        assert.equal(metrics.byPaymentToken.wvc[key], undefined);
    }
});
