import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import * as _mod from "../src/common/indexer.js";

// tsx CJS-interop: named exports land on the .default namespace object
const {
    INDEX_SCHEMA_VERSION,
    emptyState,
    ingest,
    rewind,
    eventId,
    normaliseEvent,
    lag,
    queryEvents,
    reconcile,
    resolveCreators,
    annotateSale,
    serialize,
    deserialize,
    listingKey,
    tokenKey,
} = _mod.default || _mod;

const fixture = JSON.parse(
    fs.readFileSync(new URL("./fixtures-chain207-logs.json", import.meta.url))
);

const ABI = {
    marketplace: JSON.parse(
        fs.readFileSync(new URL("../src/abis/Marketplace.json", import.meta.url))
    ),
    text: JSON.parse(
        fs.readFileSync(new URL("../src/abis/TextNFT.json", import.meta.url))
    ),
    image: JSON.parse(
        fs.readFileSync(new URL("../src/abis/ImageNFT.json", import.meta.url))
    ),
};

const TEXT = fixture.contracts.text.address;
const MARKETPLACE = fixture.contracts.marketplace.address;
const ALICE = "0x12BD0b15D5010De455DCe7944265Fe1D35a84023";
const BOB = "0x90e839B02e0285bf3dC52FaeB96a967352e4f2f4";
const ZERO = ethers.constants.AddressZero;
const TEXT_1_1 = listingKey(TEXT, "1", "1");
const TEXT_1_0 = listingKey(TEXT, "1", "0");

/** Decode the captured raw logs exactly as eventScan's cached pass does. */
function decoded(which) {
    const iface = new ethers.utils.Interface(
        ABI[which].abi ?? ABI[which]
    );
    return fixture.logs[which].flatMap((log) => {
        let parsed;
        try {
            parsed = iface.parseLog(log);
        } catch (e) {
            return [];
        }
        return [{ ...log, event: parsed.name, args: parsed.args }];
    });
}

const CHAIN_LOGS = [
    ...decoded("marketplace"),
    ...decoded("text"),
    ...decoded("image"),
];
const HEAD = fixture.capturedAtBlock;

const fullIndex = () =>
    ingest(emptyState(), CHAIN_LOGS, {
        address: MARKETPLACE,
        fromBlock: fixture.contracts.marketplace.firstBlock,
        toBlock: HEAD,
        at: 1_700_000_000_000,
    });

// ---------------------------------------------------------------------------
// The fold against live chain-207 state
// ---------------------------------------------------------------------------

test("the fixture is the complete deployed history, not a sample", () => {
    const names = decoded("marketplace").map((e) => e.event);
    assert.equal(names.filter((n) => n === "TokenListed").length, 7);
    assert.equal(names.filter((n) => n === "TokenDelisted").length, 1);
    assert.equal(names.filter((n) => n === "TokenPurchased").length, 2);
    // Only three tokens have ever been minted across both collections.
    assert.equal(decoded("text").filter((e) => e.event === "TransferSingle").length, 3);
    assert.equal(decoded("image").filter((e) => e.event === "TransferSingle").length, 2);
});

test("listing text:1:1 folds to amount 3, matching the live listings() read", () => {
    const state = fullIndex();
    // The flagship assertion. A last-writer-wins fold over TokenListed alone
    // reports 4 — the last TokenListed for this listing says 4 — but two
    // purchases decremented it with no TokenListed following. The chain says 3.
    assert.equal(
        state.listings[TEXT_1_1].amount,
        fixture.liveReads["listings(text,1,1)"].amount
    );
    assert.equal(
        state.listings[TEXT_1_1].price,
        fixture.liveReads["listings(text,1,1)"].price
    );
    assert.equal(state.listings[TEXT_1_1].seller, ALICE);
});

test("listing text:1:0 folds to zero after its TokenDelisted", () => {
    const state = fullIndex();
    assert.equal(state.listings[TEXT_1_0].amount, 0);
    assert.equal(fixture.liveReads["listings(text,1,0)"].amount, 0);
});

test("exactly one listing is open, and listingCount matches the live read", () => {
    const state = fullIndex();
    const open = Object.values(state.listings).filter((l) => l.amount > 0);
    assert.equal(open.length, 1);
    assert.equal(open[0].price, "50000000000000000000");
    // Two listing ids have ever existed for text:1; the delisted one still counts.
    const forToken = Object.keys(state.listings).filter((k) =>
        k.startsWith("text:1:")
    );
    assert.equal(forToken.length, fixture.liveReads["listingCount(text,1)"]);
});

test("balances fold to the live balanceOf reads", () => {
    const state = fullIndex();
    assert.deepEqual(state.balances["text:1"], {
        [ALICE]: fixture.liveReads[`balanceOf(text,${ALICE},1)`],
        [BOB]: fixture.liveReads[`balanceOf(text,${BOB},1)`],
    });
    assert.equal(state.balances["text:1"][ALICE], 98);
    assert.equal(state.balances["text:1"][BOB], 2);
});

test("per-token first and last block are indexed", () => {
    const state = fullIndex();
    // Mint at 3694261, last purchase at 3698029.
    assert.equal(state.tokens["text:1"].firstBlock, 3694261);
    assert.equal(state.tokens["text:1"].lastBlock, 3698029);
    assert.equal(state.tokens["image:2"].firstBlock, 7010813);
});

// ---------------------------------------------------------------------------
// identity, idempotency and reorg rewind
// ---------------------------------------------------------------------------

test("eventId distinguishes the entries expanded from one TransferBatch", () => {
    const batch = {
        event: "TransferBatch",
        address: TEXT,
        blockNumber: 10,
        transactionIndex: 0,
        logIndex: 2,
        transactionHash: "0xbatch",
        args: {
            operator: ALICE,
            from: ZERO,
            to: BOB,
            ids: [ethers.BigNumber.from(1), ethers.BigNumber.from(2)],
            values: [ethers.BigNumber.from(3), ethers.BigNumber.from(4)],
        },
    };
    const ids = normaliseEvent(batch).map(eventId);
    assert.equal(new Set(ids).size, 2, "a sub-index collision drops half a batch");
    assert.deepEqual(ids, ["10:0:2:0", "10:0:2:1"]);
});

test("a batch mint folds into balances for every id it carries", () => {
    const state = ingest(emptyState(), [
        {
            event: "TransferBatch",
            address: TEXT,
            blockNumber: 10,
            transactionIndex: 0,
            logIndex: 0,
            transactionHash: "0xbatch",
            args: {
                operator: ALICE,
                from: ZERO,
                to: BOB,
                ids: [ethers.BigNumber.from(1), ethers.BigNumber.from(2)],
                values: [ethers.BigNumber.from(3), ethers.BigNumber.from(4)],
            },
        },
    ]);
    assert.equal(state.balances["text:1"][BOB], 3);
    assert.equal(state.balances["text:2"][BOB], 4);
});

test("re-ingesting an overlapping tail after a rewind matches a clean ingest", () => {
    const clean = fullIndex();

    // The rewind eventScan's REORG_RESCAN_DEPTH performs, then the re-ingest of
    // the rescanned range. The purchase fold DECREMENTS, so an implementation
    // that appended the overlap instead of keying it would report a lower
    // amount here, not an equal one.
    const rewindFrom = 3698029 - 128;
    const rewound = rewind(clean, rewindFrom);
    assert.ok(
        Object.keys(rewound.events).length < Object.keys(clean.events).length,
        "the rewind must actually drop the tail"
    );

    const replayed = ingest(
        rewound,
        CHAIN_LOGS.filter((log) => log.blockNumber >= rewindFrom),
        { address: MARKETPLACE, toBlock: HEAD, at: 1_700_000_000_000 }
    );

    assert.equal(
        Object.keys(replayed.events).length,
        Object.keys(clean.events).length,
        "replaying the overlap must not grow the event count"
    );
    assert.deepEqual(replayed.listings, clean.listings);
    assert.deepEqual(replayed.balances, clean.balances);
    assert.equal(replayed.listings[TEXT_1_1].amount, 3);
});

test("a rewind past a purchase restores the pre-purchase listed amount", () => {
    const state = fullIndex();
    // Anti-vacuity for the test above: the rewind boundary must actually move
    // derived state, or 'deep-equal after replay' proves nothing.
    const before = rewind(state, 3698029);
    assert.equal(before.listings[TEXT_1_1].amount, 4);
});

test("ingesting the same logs twice changes nothing", () => {
    const once = fullIndex();
    const twice = ingest(once, CHAIN_LOGS, {
        address: MARKETPLACE,
        toBlock: HEAD,
        at: 1_700_000_000_000,
    });
    assert.deepEqual(twice.listings, once.listings);
    assert.deepEqual(twice.balances, once.balances);
    assert.equal(
        Object.keys(twice.events).length,
        Object.keys(once.events).length
    );
});

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

test("lag is null on an index that has never ingested, not zero", () => {
    // Zero would present an empty index as perfectly fresh — the exact failure
    // a freshness signal exists to prevent.
    assert.equal(lag(emptyState(), HEAD), null);
});

test("lag reports the block distance from the scan head", () => {
    const state = ingest(emptyState(), CHAIN_LOGS, {
        address: MARKETPLACE,
        toBlock: 4_000_000,
        at: 1_700_000_000_000,
    });
    assert.equal(lag(state, 4_000_500).blocks, 500);
    assert.equal(
        lag(state, 4_000_500, 1_700_000_060_000).seconds,
        60
    );
});

test("lag is measured against the scan head, not the newest event", () => {
    // An index scanned to head with no recent events is fresh, not stale.
    const state = ingest(emptyState(), CHAIN_LOGS, {
        address: MARKETPLACE,
        toBlock: HEAD,
    });
    assert.equal(lag(state, HEAD).blocks, 0);
});

test("coverage records the scanned range rather than implying global state", () => {
    const state = fullIndex();
    const range = state.coverage[MARKETPLACE.toLowerCase()];
    assert.deepEqual(range, {
        fromBlock: fixture.contracts.marketplace.firstBlock,
        toBlock: HEAD,
    });
});

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

test("paging the index concatenates to the unpaged result with no gap or repeat", () => {
    const state = fullIndex();
    const all = queryEvents(state, { limit: 1000 }).rows.map((r) => r.id);

    const paged = [];
    let cursor = null;
    do {
        const page = queryEvents(state, { limit: 5, cursor });
        paged.push(...page.rows.map((r) => r.id));
        cursor = page.nextCursor;
    } while (cursor);

    assert.deepEqual(paged, all);
    assert.equal(new Set(paged).size, paged.length);
});

test("a record arriving at the head does not shift an earlier page", () => {
    const state = fullIndex();
    const first = queryEvents(state, { limit: 5 });
    const secondBefore = queryEvents(state, {
        limit: 5,
        cursor: first.nextCursor,
    });

    const grown = ingest(state, [
        {
            event: "TransferSingle",
            address: TEXT,
            blockNumber: HEAD,
            transactionIndex: 0,
            logIndex: 0,
            transactionHash: "0xnew",
            args: {
                operator: ALICE,
                from: ALICE,
                to: BOB,
                id: ethers.BigNumber.from(1),
                value: ethers.BigNumber.from(1),
            },
        },
    ]);

    const secondAfter = queryEvents(grown, {
        limit: 5,
        cursor: first.nextCursor,
    });
    // limit/offset would slide here; a cursor on the sort key cannot.
    assert.deepEqual(
        secondAfter.rows.map((r) => r.id),
        secondBefore.rows.map((r) => r.id)
    );
});

test("queryEvents filters by event, token and address", () => {
    const state = fullIndex();
    assert.equal(
        queryEvents(state, { filter: { event: "TokenListed" }, limit: 100 }).rows
            .length,
        7
    );
    assert.equal(
        queryEvents(state, { filter: { nftType: "image" }, limit: 100 }).rows
            .length,
        2
    );
    assert.equal(
        queryEvents(state, { filter: { address: BOB }, limit: 100 }).rows.length,
        4
    );
});

// ---------------------------------------------------------------------------
// creator (a contract read, not an event)
// ---------------------------------------------------------------------------

test("creator is read once per token, never once per event", async () => {
    const state = fullIndex();
    const calls = [];
    const resolved = await resolveCreators(state, {
        authorOf: async (nftAddress, tokenId) => {
            calls.push(`${nftAddress}:${tokenId}`);
            return ALICE;
        },
    });

    assert.equal(resolved.tokens["text:1"].creator, ALICE);
    assert.equal(
        fixture.liveReads["authorOf(text,1)"],
        resolved.tokens["text:1"].creator
    );
    // text:1 carries eight indexed records; a per-event read would call eight
    // times for that token alone.
    assert.ok(
        queryEvents(state, { filter: { tokenId: "1", nftType: "text" }, limit: 100 })
            .rows.length >= 8
    );
    assert.equal(calls.filter((c) => c === `${TEXT}:1`).length, 1);
    assert.equal(calls.length, Object.keys(state.tokens).length);
});

test("a reverting authorOf yields creator null, not a fabricated address", async () => {
    const state = fullIndex();
    const resolved = await resolveCreators(state, {
        authorOf: async () => {
            throw new Error("execution reverted");
        },
    });
    assert.equal(resolved.tokens["text:1"].creator, null);
});

// ---------------------------------------------------------------------------
// fees per sale
// ---------------------------------------------------------------------------

const SALES = {
    "0x49d5516e8ed4ffe1c43d0737a1906163e825d102b48a23f79cc582d5471c1cfa": {
        total: "1000000000000000000",
        platformFee: "50000000000000000",
        creatorFee: "95000000000000000",
        sellerProceeds: "855000000000000000",
    },
    "0xf1a390bc99d17d820d0d6bca0ce1b1bc9b08bb8234b58692d998d5285a081f0b": {
        total: "50000000000000000000",
        platformFee: "2500000000000000000",
        creatorFee: "4750000000000000000",
        sellerProceeds: "42750000000000000000",
    },
};

function saleIdFor(state, transactionHash) {
    const sale = state.sales.find((s) => s.transactionHash === transactionHash);
    assert.ok(sale, `no indexed sale for ${transactionHash}`);
    return sale.id;
}

/** royaltyInfo on the deployed generation: 10% of the post-platform-fee remainder. */
const royaltyOf = (total, bps) => {
    const value = ethers.BigNumber.from(total);
    const remainder = value.sub(value.mul(bps).div(10000));
    return remainder.div(10);
};

test("both real sales index a fee split that matches their receipt legs", () => {
    let state = fullIndex();

    for (const [txHash, expected] of Object.entries(SALES)) {
        const id = saleIdFor(state, txHash);
        const legs = fixture.purchaseReceiptLegs[txHash];
        assert.equal(legs.length, 3, "each sale pays three ERC-20 legs");

        state = annotateSale(state, id, {
            // Read at the sale's own block: this RPC serves archive state, so
            // there is no reason to substitute the current fee.
            platformFeeBps: fixture.liveReads.platformFeePercentage,
            royaltyAmount: royaltyOf(
                expected.total,
                fixture.liveReads.platformFeePercentage
            ),
            royaltyReceiver: ALICE,
            receiptLegs: legs,
        });

        const settlement = state.sales.find((s) => s.id === id).settlement;
        assert.equal(settlement.platformFee, expected.platformFee);
        assert.equal(settlement.creatorFee, expected.creatorFee);
        assert.equal(settlement.sellerProceeds, expected.sellerProceeds);
        assert.equal(
            ethers.BigNumber.from(settlement.platformFee)
                .add(settlement.creatorFee)
                .add(settlement.sellerProceeds)
                .toString(),
            expected.total,
            "the three legs must sum to exactly the sale total"
        );
        assert.equal(settlement.legsAgree, true);
    }
});

test("legs perturbed by one wei set legsAgree false", () => {
    // Anti-vacuity: without this the agreement flag passes for any input.
    const state = fullIndex();
    const txHash = Object.keys(SALES)[0];
    const id = saleIdFor(state, txHash);
    const legs = fixture.purchaseReceiptLegs[txHash].map((leg, i) => ({
        ...leg,
        value:
            i === 0
                ? ethers.BigNumber.from(leg.value).add(1).toString()
                : leg.value,
    }));

    const annotated = annotateSale(state, id, {
        platformFeeBps: 500,
        royaltyAmount: royaltyOf(SALES[txHash].total, 500),
        royaltyReceiver: ALICE,
        receiptLegs: legs,
    });
    const settlement = annotated.sales.find((s) => s.id === id).settlement;
    assert.equal(settlement.legsAgree, false);
});

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

function agreeingReads(state) {
    return {
        listings: async (nftAddress, tokenId, listingId) => {
            const listing =
                state.listings[listingKey(nftAddress, tokenId, listingId)];
            return { amount: listing.amount, price: listing.price };
        },
        listingCount: async (nftAddress, tokenId) =>
            Object.keys(state.listings).filter((key) =>
                key.startsWith(`${tokenKey(nftAddress, tokenId)}:`)
            ).length,
        balanceOf: async (nftAddress, address, tokenId) =>
            state.balances[tokenKey(nftAddress, tokenId)]?.[address] ?? 0,
    };
}

test("reconcile reports nothing when the chain agrees with the fold", async () => {
    const state = fullIndex();
    const discrepancies = await reconcile(state, agreeingReads(state));
    assert.deepEqual(discrepancies, []);
});

test("reconcile names the exact listing the chain disagrees about", async () => {
    const state = fullIndex();
    const reads = agreeingReads(state);
    const discrepancies = await reconcile(state, {
        ...reads,
        listings: async (nftAddress, tokenId, listingId) => {
            const base = await reads.listings(nftAddress, tokenId, listingId);
            const key = listingKey(nftAddress, tokenId, listingId);
            return key === TEXT_1_1 ? { ...base, amount: 2 } : base;
        },
    });

    assert.equal(discrepancies.length, 1);
    assert.deepEqual(discrepancies[0], {
        check: "listing.amount",
        subject: TEXT_1_1,
        expected: 3,
        actual: 2,
    });
});

test("reconcile reports a failed read instead of throwing", async () => {
    const state = fullIndex();
    const discrepancies = await reconcile(state, {
        listings: async () => {
            throw new Error("node unavailable");
        },
        listingCount: async () => {
            throw new Error("node unavailable");
        },
        balanceOf: async () => {
            throw new Error("node unavailable");
        },
    });
    assert.ok(discrepancies.length > 0);
    assert.ok(discrepancies.every((d) => d.error === "node unavailable"));
});

// ---------------------------------------------------------------------------
// checkpoint and schema version
// ---------------------------------------------------------------------------

test("resuming from a checkpoint equals one clean ingest", () => {
    const splitAt = 3696000;
    const early = ingest(
        emptyState(),
        CHAIN_LOGS.filter((l) => l.blockNumber < splitAt),
        { address: MARKETPLACE, toBlock: splitAt - 1, at: 1_700_000_000_000 }
    );

    const file = path.join(os.tmpdir(), `vinunft-index-${process.pid}.json`);
    fs.writeFileSync(file, serialize(early));
    const restored = deserialize(fs.readFileSync(file, "utf8"));
    fs.unlinkSync(file);

    const resumed = ingest(
        restored,
        CHAIN_LOGS.filter((l) => l.blockNumber >= splitAt),
        { address: MARKETPLACE, toBlock: HEAD, at: 1_700_000_000_000 }
    );
    const clean = fullIndex();

    assert.deepEqual(resumed.events, clean.events);
    assert.deepEqual(resumed.listings, clean.listings);
    assert.deepEqual(resumed.balances, clean.balances);
    assert.equal(resumed.lastIndexedBlock, clean.lastIndexedBlock);
});

test("a checkpoint from another schema version is discarded, not merged", () => {
    const state = fullIndex();
    const payload = JSON.parse(serialize(state));
    payload.version = INDEX_SCHEMA_VERSION - 1;

    const restored = deserialize(JSON.stringify(payload));
    assert.deepEqual(restored.events, {});
    assert.deepEqual(restored.listings, {});
    assert.equal(restored.lastIndexedBlock, null);
});

test("the version constant is actually read, and garbage deserialises empty", () => {
    const state = fullIndex();
    // Mutating the stamped version must go red; if deserialize ignored it this
    // round trip would still restore the events.
    assert.equal(JSON.parse(serialize(state)).version, INDEX_SCHEMA_VERSION);
    assert.deepEqual(deserialize(serialize(state)).listings, state.listings);
    assert.deepEqual(deserialize("{not json").events, {});
});

// ---------------------------------------------------------------------------
// Network-gated: the same reconciliation against the live chain.
//
// Skipped by default so `yarn test` stays hermetic and a throttled public RPC
// can never redden the gate. Run with VINUNFT_LIVE_RECONCILE=1.
// ---------------------------------------------------------------------------

test(
    "live: the fold reconciles against the deployed contracts",
    { skip: !process.env.VINUNFT_LIVE_RECONCILE },
    async () => {
        const provider = new ethers.providers.JsonRpcProvider(
            "https://rpc.vinuchain.org"
        );
        const marketplace = new ethers.Contract(
            MARKETPLACE,
            ABI.marketplace.abi ?? ABI.marketplace,
            provider
        );
        const nft = (address) =>
            new ethers.Contract(
                address,
                (address.toLowerCase() === TEXT.toLowerCase()
                    ? ABI.text.abi ?? ABI.text
                    : ABI.image.abi ?? ABI.image),
                provider
            );

        const discrepancies = await reconcile(fullIndex(), {
            listings: (nftAddress, tokenId, listingId) =>
                marketplace.listings(nftAddress, tokenId, listingId),
            listingCount: async (nftAddress, tokenId) =>
                (await marketplace.listingCount(nftAddress, tokenId)).toNumber(),
            balanceOf: async (nftAddress, address, tokenId) =>
                (await nft(nftAddress).balanceOf(address, tokenId)).toNumber(),
        });

        assert.deepEqual(discrepancies, []);
    }
);

test("paging holds when the last page is exactly the limit", () => {
    // The 3/5/2 split of the real fixture never exercises an exact-multiple
    // final page, where an off-by-one in the terminal cursor would silently
    // drop or repeat the tail.
    const state = fullIndex();
    const total = queryEvents(state, { limit: 1000 }).rows.length;

    for (const limit of [1, total]) {
        const paged = [];
        let cursor = null;
        let pages = 0;
        do {
            const page = queryEvents(state, { limit, cursor });
            paged.push(...page.rows.map((r) => r.id));
            cursor = page.nextCursor;
            pages++;
            assert.ok(pages <= total + 2, "pagination must terminate");
        } while (cursor);

        assert.equal(paged.length, total, `limit ${limit} lost or repeated rows`);
        assert.equal(new Set(paged).size, total);
        // A page that exhausts the rows must terminate, not hand back a cursor
        // that costs the caller one more empty round trip.
        assert.equal(pages, Math.ceil(total / limit), `limit ${limit} over-paged`);
    }
});

test("coverage is per contract, and its absence is visible rather than implied", () => {
    // A state can hold NFT events while carrying no NFT coverage entry: the
    // caller records the range it actually scanned, one ingest per contract.
    // The gap is meant to be READABLE — an absent entry means "not known to be
    // scanned", never "scanned and empty".
    const marketplaceOnly = fullIndex();
    assert.equal(marketplaceOnly.coverage[TEXT.toLowerCase()], undefined);
    assert.ok(Object.keys(marketplaceOnly.balances).length > 0);

    const withNft = ingest(marketplaceOnly, decoded("text"), {
        address: TEXT,
        fromBlock: fixture.contracts.text.firstBlock,
        toBlock: HEAD,
    });
    assert.deepEqual(withNft.coverage[TEXT.toLowerCase()], {
        fromBlock: fixture.contracts.text.firstBlock,
        toBlock: HEAD,
    });
});
