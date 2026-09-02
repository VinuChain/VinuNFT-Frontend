import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ethers } from "ethers";
import * as _loader from "../src/common/indexLoader.js";
import * as _scan from "../src/common/eventScan.js";

// tsx CJS-interop: named exports land on the .default namespace object.
const { loadIndex, listingRowsFromIndex, profileFromIndex, _resetIndex } =
    _loader.default || _loader;
const { _resetLogCache } = _scan.default || _scan;

const fixture = JSON.parse(
    fs.readFileSync(new URL("./fixtures-chain207-logs.json", import.meta.url))
);
const abi = (name) =>
    JSON.parse(
        fs.readFileSync(new URL(`../src/abis/${name}.json`, import.meta.url))
    ).abi;

const TEXT = fixture.contracts.text.address;
const MARKETPLACE = fixture.contracts.marketplace.address;
const ALICE = "0x12BD0b15D5010De455DCe7944265Fe1D35a84023";
const BOB = "0x90e839B02e0285bf3dC52FaeB96a967352e4f2f4";
const WVC = "0xEd8c5530a0A086a12f57275728128a60DFf04230";
const HEAD = fixture.capturedAtBlock;
// An ERC-20 outside config.tokens and an NFT collection outside config, both
// reachable: listToken constrains neither the payment token nor the collection.
const UNKNOWN_TOKEN = ethers.utils.getAddress(`0x${"de".repeat(20)}`);
const UNKNOWN_COLLECTION = ethers.utils.getAddress(`0x${"ab".repeat(20)}`);

const textIface = new ethers.utils.Interface(abi("TextNFT"));
const marketplaceIface = new ethers.utils.Interface(abi("Marketplace"));
const erc20Iface = new ethers.utils.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const ALL_LOGS = Object.values(fixture.logs).flat();

/** Exactly the four members ethers needs from a provider, plus counters. */
function fakeProvider({
    logs = ALL_LOGS,
    head = HEAD,
    failLogsFor = null,
    failReceipts = false,
    textUri = "data:text/markdown,# hi",
    // 500 bps at every block unless a test stages a rate change. The live
    // receipts prove 500: sale 1 paid 0.05 of a 1.0 WVC total.
    feeBpsAt = () => 500,
} = {}) {
    const counts = { getLogs: 0, call: 0, receipt: 0 };
    const calls = [];
    const provider = {
        counts,
        calls,
        head,
        // Mutable like `head`: a reorg test stages different content for the
        // same token id across two loads.
        textUri,
        _isProvider: true,
        getNetwork: async () => ({ chainId: 207, name: "vinu" }),
        resolveName: async (name) => name,
        getBlockNumber: async () => provider.head,
        async getLogs({ address, fromBlock, toBlock }) {
            counts.getLogs += 1;
            if (
                failLogsFor &&
                String(address).toLowerCase() === failLogsFor.toLowerCase()
            ) {
                throw new Error("throttled");
            }
            return logs.filter(
                (log) =>
                    log.address.toLowerCase() ===
                        String(address).toLowerCase() &&
                    log.blockNumber >= fromBlock &&
                    log.blockNumber <= toBlock
            );
        },
        // Dispatches on selector AND block tag: a stub that ignores the block
        // cannot tell a per-sale historical read from the current rate, which
        // is the whole point of the settlement resolution below.
        async call({ to, data }, blockTag) {
            counts.call += 1;
            const target = String(to).toLowerCase();
            if (target === MARKETPLACE.toLowerCase()) {
                calls.push({ fn: "platformFeePercentage", blockTag });
                return marketplaceIface.encodeFunctionResult(
                    "platformFeePercentage",
                    [feeBpsAt(blockTag)]
                );
            }
            const fragment = textIface.getFunction(data.slice(0, 10));
            const args = textIface.decodeFunctionData(fragment, data);
            calls.push({ fn: fragment.name, blockTag, args });
            if (fragment.name === "authorOf") {
                return textIface.encodeFunctionResult("authorOf", [ALICE]);
            }
            if (fragment.name === "textURI") {
                return textIface.encodeFunctionResult("textURI", [
                    provider.textUri,
                ]);
            }
            if (fragment.name === "royaltyInfo") {
                const base = ethers.BigNumber.from(args[1]);
                return textIface.encodeFunctionResult("royaltyInfo", [
                    ALICE,
                    base.mul(1000).div(10000),
                ]);
            }
            throw new Error(`unstubbed call ${fragment.name}`);
        },
        async getTransactionReceipt(hash) {
            counts.receipt += 1;
            if (failReceipts) {
                throw new Error("receipt unavailable");
            }
            return {
                status: 1,
                transactionHash: hash,
                logs: (fixture.purchaseReceiptLegs[hash] ?? []).map((leg) =>
                    rawLog(
                        erc20Iface,
                        leg.token,
                        "Transfer",
                        [leg.from, leg.to, leg.value],
                        0
                    )
                ),
            };
        },
    };
    return provider;
}

function reset() {
    _resetIndex();
    _resetLogCache();
}

function rawLog(iface, address, name, values, blockNumber, logIndex = 0) {
    const { data, topics } = iface.encodeEventLog(iface.getEvent(name), values);
    return {
        address: address.toLowerCase(),
        topics,
        data,
        blockNumber,
        transactionIndex: 0,
        logIndex,
        transactionHash: `0x${String(blockNumber).padStart(64, "0")}`,
        removed: false,
    };
}

// ---------------------------------------------------------------------------
// The seam: chain -> fold -> derived state
// ---------------------------------------------------------------------------

test("the loader folds the whole deployed history and reports the block it reached", async () => {
    reset();
    const provider = fakeProvider();
    const { state, headBlock } = await loadIndex(provider);

    assert.equal(headBlock, HEAD);
    assert.equal(state.lastIndexedBlock, HEAD);
    // Every log the three contracts have ever emitted (11 + 4 + 2), minus the
    // two that carry no indexed state: OwnershipTransferred and URI.
    assert.equal(Object.keys(state.events).length, 15);
    assert.equal(
        state.listings["text:1:1"].amount,
        fixture.liveReads["listings(text,1,1)"].amount
    );
});

test("cold and warm scan cost: one chunked pass per contract, then only the tail", async () => {
    reset();
    const provider = fakeProvider();

    await loadIndex(provider);
    const cold = provider.counts.getLogs;
    const coldCalls = provider.counts.call;

    // 100000-block ranges from each contract's verified first block to head.
    assert.equal(cold, 375);
    // Measured, not remembered: 3 authorOf (one per token ever sighted), 2
    // platformFeePercentage and 2 royaltyInfo (one pair per sale, at that
    // sale's block), 1 textURI (one per listed text token). Plus 2 receipts,
    // counted separately below.
    assert.equal(coldCalls, 8);
    assert.equal(provider.counts.receipt, 2);

    // A revisit with the head advanced re-reads only the reorg rescan window.
    provider.head = HEAD + 50;
    await loadIndex(provider);
    const warm = provider.counts.getLogs - cold;
    assert.equal(warm, 3, "a warm load must not repeat the full pass");
    assert.equal(
        provider.counts.call - coldCalls,
        0,
        "creators already resolved must not be re-read"
    );
});

test("concurrent consumers share one pass", async () => {
    reset();
    const provider = fakeProvider();
    await Promise.all([loadIndex(provider), loadIndex(provider)]);
    assert.equal(provider.counts.getLogs, 375);
});

test("one failed contract scan fails the load; no partial index is published", async () => {
    reset();
    const provider = fakeProvider({ failLogsFor: TEXT });

    await assert.rejects(() => loadIndex(provider), /throttled/);

    // The marketplace scan may well have succeeded. Publishing it would show
    // listings with no transfers behind them and call that the marketplace.
    const healthy = fakeProvider();
    const { state } = await loadIndex(healthy);
    assert.equal(state.lastIndexedBlock, HEAD);
    assert.ok(Object.keys(state.balances).length > 0);
});

// ---------------------------------------------------------------------------
// Listing rows
// ---------------------------------------------------------------------------

test("listing rows reproduce the live chain state, with the balance folded not read", async () => {
    reset();
    const provider = fakeProvider();
    const { state, formats } = await loadIndex(provider);
    const callsBefore = provider.counts.call;

    const { rows, unrecognisedPaymentToken, unknownCollection } =
        listingRowsFromIndex(state, formats);

    assert.equal(unrecognisedPaymentToken, 0);
    assert.equal(unknownCollection, 0);
    assert.deepEqual(rows, [
        {
            nftType: "text",
            tokenId: 1,
            listingId: 1,
            seller: ALICE,
            amount: fixture.liveReads["listings(text,1,1)"].amount,
            price: "50.0",
            priceRaw: fixture.liveReads["listings(text,1,1)"].price,
            paymentToken: "wvc",
            paymentTokenAddress: WVC,
            sellerBalance:
                fixture.liveReads[`balanceOf(text,${ALICE},1)`],
            supply: 100,
            creator: fixture.liveReads["authorOf(text,1)"],
            format: "text/markdown",
        },
    ]);
    // The delisted slot 0 is folded to zero and never becomes a row.
    assert.equal(state.listings["text:1:0"].amount, 0);
    assert.equal(
        provider.counts.call,
        callsBefore,
        "sellerBalance must come from the fold, not a balanceOf call"
    );
});

test("a listing the app cannot price or link is counted, never silently dropped", async () => {
    reset();
    const provider = fakeProvider({
        logs: [
            ...ALL_LOGS,
            rawLog(
                marketplaceIface,
                MARKETPLACE,
                "TokenListed",
                [
                    TEXT,
                    9,
                    ALICE,
                    0,
                    1,
                    UNKNOWN_TOKEN,
                    ethers.utils.parseUnits("1", 18),
                ],
                3700000
            ),
            rawLog(
                marketplaceIface,
                MARKETPLACE,
                "TokenListed",
                [
                    UNKNOWN_COLLECTION,
                    1,
                    ALICE,
                    0,
                    1,
                    WVC,
                    ethers.utils.parseUnits("1", 18),
                ],
                3700001
            ),
        ],
    });

    const { state, formats } = await loadIndex(provider);
    const { rows, unrecognisedPaymentToken, unknownCollection } =
        listingRowsFromIndex(state, formats);

    assert.equal(unrecognisedPaymentToken, 1);
    assert.equal(unknownCollection, 1);
    // The unrecognised-token listing is a real active listing on a collection
    // this app can link, so it is rendered without a price rather than hidden.
    // Only the unknown COLLECTION has no route and stays counted-not-shown.
    assert.equal(rows.length, 2);
    const unpriced = rows.find((row) => row.tokenId === 9);
    assert.equal(unpriced.paymentToken, null);
    assert.equal(unpriced.price, null);
    assert.equal(unpriced.priceRaw, null);
    assert.equal(unpriced.paymentTokenAddress, UNKNOWN_TOKEN);
});

// ---------------------------------------------------------------------------
// Address profiles
// ---------------------------------------------------------------------------

test("a profile covers every edition, listing and sale, not a recent window", async () => {
    reset();
    const { state } = await loadIndex(fakeProvider());

    const alice = profileFromIndex(state, ALICE);
    assert.deepEqual(
        alice.owned.find((n) => n.type === "text" && n.id === 1),
        { type: "text", id: 1, balance: 98 }
    );
    assert.deepEqual(alice.listed, [{ type: "text", id: 1 }]);
    assert.deepEqual(alice.sold, [{ type: "text", id: 1 }]);
    assert.deepEqual(alice.bought, []);
    // Both sales are of the same token; it is listed once, not twice.
    assert.equal(state.sales.length, 2);

    const bob = profileFromIndex(state, BOB);
    assert.deepEqual(bob.owned, [{ type: "text", id: 1, balance: 2 }]);
    assert.deepEqual(bob.bought, [{ type: "text", id: 1 }]);
    assert.deepEqual(bob.created, []);
    assert.deepEqual(bob.listed, []);

    // Case-insensitive: an address typed in lower case is the same address.
    assert.deepEqual(profileFromIndex(state, BOB.toLowerCase()), bob);
});

test("a token outside any recent window is still in the profile and the rows", async () => {
    reset();
    // Two live listings 100 token ids apart. The older one is what any
    // latest-N window drops, so asserting on the newer one alone would pass
    // against the very bound this change removes.
    const listed = (tokenId, block, units) => [
        rawLog(
            textIface,
            TEXT,
            "TransferSingle",
            [ALICE, ethers.constants.AddressZero, ALICE, tokenId, units],
            block
        ),
        rawLog(
            marketplaceIface,
            MARKETPLACE,
            "TokenListed",
            [TEXT, tokenId, ALICE, 0, 2, WVC, ethers.utils.parseUnits("7", 18)],
            block + 1
        ),
    ];
    const provider = fakeProvider({
        logs: [...ALL_LOGS, ...listed(4000, 3700000, 5), ...listed(4100, 3700010, 9)],
    });

    const { state } = await loadIndex(provider);
    const { rows } = listingRowsFromIndex(state);

    assert.deepEqual(
        rows.map((r) => r.tokenId).sort((a, b) => a - b),
        [1, 4000, 4100],
        "every active listing is reachable, not just the newest tokens"
    );

    const old = rows.find((r) => r.tokenId === 4000);
    assert.equal(old.sellerBalance, 5);
    assert.equal(old.price, "7.0");
    assert.ok(
        profileFromIndex(state, ALICE).owned.some((n) => n.id === 4000),
        "and the same token must appear in its owner's profile"
    );
});

// ---------------------------------------------------------------------------
// Row fields the card needs: raw price, supply, creator, format
// ---------------------------------------------------------------------------

test("a row carries the raw price, the token's whole supply, its creator and its format", async () => {
    reset();
    const provider = fakeProvider();
    const { state, formats } = await loadIndex(provider);
    const [row] = listingRowsFromIndex(state, formats).rows;

    // The unit price in base units, so the card can charge price x amount and
    // the comparator never has to re-parse a formatted string.
    assert.equal(row.priceRaw, fixture.liveReads["listings(text,1,1)"].price);
    assert.equal(row.paymentTokenAddress, WVC);

    // Supply is every unit in existence, folded from the transfers: 100 minted,
    // 98 with the seller and 2 with the buyer. It is NOT the listed amount.
    assert.equal(row.supply, 100);
    assert.notEqual(row.supply, row.amount);

    assert.equal(row.creator, fixture.liveReads["authorOf(text,1)"]);
    assert.equal(row.format, "text/markdown");
});

test("an image listing needs no extra read to state its format", async () => {
    reset();
    const provider = fakeProvider({ textUri: "data:text/plain,x" });
    await loadIndex(provider);
    const before = provider.calls.filter((c) => c.fn === "textURI").length;
    assert.equal(before, 1, "one textURI read per listed text token, no more");
});

test("a failed format read degrades the field, never the listing", async () => {
    reset();
    const provider = fakeProvider();
    provider.call = async () => {
        provider.counts.call += 1;
        throw new Error("reverted");
    };
    const { state, formats } = await loadIndex(provider);
    const { rows } = listingRowsFromIndex(state, formats);

    assert.equal(rows.length, 1, "the listing survives every failed read");
    assert.equal(rows[0].format, null);
    assert.equal(rows[0].creator, null);
    assert.equal(rows[0].supply, 100, "supply is folded, so no read can lose it");
});

// ---------------------------------------------------------------------------
// Settlement: the fee split of each sale, read at that sale's own block
// ---------------------------------------------------------------------------

test("each sale's split is derived at its own block and agrees with its receipt", async () => {
    reset();
    const provider = fakeProvider();
    const { state } = await loadIndex(provider);

    const byBlock = Object.fromEntries(
        state.sales.map((sale) => [sale.blockNumber, sale.settlement])
    );

    // tx 0x49d5516e: 0.05 platform, 0.095 royalty, 0.855 to the seller.
    assert.equal(byBlock[3696011].platformFee, "50000000000000000");
    assert.equal(byBlock[3696011].creatorFee, "95000000000000000");
    assert.equal(byBlock[3696011].sellerProceeds, "855000000000000000");
    // tx 0xf1a390bc: 2.5 / 4.75 / 42.75.
    assert.equal(byBlock[3698029].platformFee, "2500000000000000000");
    assert.equal(byBlock[3698029].creatorFee, "4750000000000000000");
    assert.equal(byBlock[3698029].sellerProceeds, "42750000000000000000");

    for (const sale of state.sales) {
        assert.equal(
            sale.settlement.legsAgree,
            true,
            "the derived split must reproduce the ERC-20 legs the buyer actually paid"
        );
    }

    // Both reads are tagged with the sale's block, never "latest".
    for (const call of provider.calls) {
        if (call.fn === "platformFeePercentage" || call.fn === "royaltyInfo") {
            assert.ok(
                [3696011, 3698029].includes(call.blockTag),
                `${call.fn} was read at ${call.blockTag}, not at the sale's block`
            );
        }
    }
});

test("a fee rate that changed between sales is not back-applied to both", async () => {
    reset();
    // decreasePlatformFeePercentage emits no event on the deployed generation,
    // so the only way to know a past rate is to read it at that past block.
    const provider = fakeProvider({
        feeBpsAt: (blockTag) => (blockTag === 3696011 ? 500 : 250),
    });
    const { state } = await loadIndex(provider);
    const byBlock = Object.fromEntries(
        state.sales.map((sale) => [sale.blockNumber, sale.settlement])
    );

    assert.equal(byBlock[3696011].platformFeeBps, 500);
    assert.equal(byBlock[3698029].platformFeeBps, 250);
    // 250 bps of 50 WVC is 1.25, where the current-rate shortcut says 2.50.
    assert.equal(byBlock[3698029].platformFee, "1250000000000000000");
    assert.equal(
        byBlock[3698029].legsAgree,
        false,
        "and the receipt legs say so, which is what makes the flag worth showing"
    );
});

test("a sale whose historical reads fail stays indexed with no split invented", async () => {
    reset();
    const provider = fakeProvider({ failReceipts: true });
    const { state } = await loadIndex(provider);

    assert.equal(state.sales.length, 2);
    for (const sale of state.sales) {
        assert.equal(
            sale.settlement,
            null,
            "an unreadable split is unknown, not zero"
        );
    }
});

test("settlements and formats are resolved once, not on every load", async () => {
    reset();
    const provider = fakeProvider();
    await loadIndex(provider);
    const cold = provider.counts.call;
    const coldReceipts = provider.counts.receipt;

    provider.head = HEAD + 50;
    await loadIndex(provider);
    assert.equal(provider.counts.call - cold, 0);
    assert.equal(provider.counts.receipt - coldReceipts, 0);
});

test("a refresh after a reorg drops the orphaned listing instead of keeping it", async () => {
    reset();
    // Inside the 128-block tail eventScan re-reads, so the second pass gets a
    // canonical answer for this very block rather than a cached one.
    const ORPHAN_BLOCK = HEAD - 5;
    const orphan = rawLog(
        marketplaceIface,
        MARKETPLACE,
        "TokenListed",
        [TEXT, 9, ALICE, 77, 1, WVC, ethers.utils.parseUnits("1", 18)],
        ORPHAN_BLOCK,
        7
    );
    const logs = [...ALL_LOGS, orphan];
    const provider = fakeProvider({ logs });

    const first = await loadIndex(provider);
    assert.equal(
        first.state.listings["text:9:77"]?.amount,
        1,
        "the listing must be folded while its block is canonical"
    );

    // The chain reorganises: that block is replaced and its log is gone. The
    // head advances, or the scan would be served entirely from cache.
    logs.splice(logs.indexOf(orphan), 1);
    provider.head = HEAD + 1;

    const second = await loadIndex(provider);
    assert.equal(
        second.state.listings["text:9:77"],
        undefined,
        "a listing whose log was orphaned must not survive the refresh"
    );
    assert.equal(
        listingRowsFromIndex(second.state, second.formats).rows.filter(
            (row) => row.listingId === 77
        ).length,
        0,
        "no row may be rendered from an orphaned log"
    );
});

test("a reorg that orphans a listed token re-reads its format, not the cached one", async () => {
    reset();
    // `formatCache` is a `textURI` READ cached per token for the lifetime of
    // the tab, and it is module state the fold's rewind cannot reach. A token
    // whose mint the rewind orphaned can come back from the canonical chain
    // with different content, so its cached format has to go with it — or the
    // marketplace keeps labelling the new token with the orphan's MIME type.
    const orphanBlock = HEAD - 5;
    const logs = [
        ...ALL_LOGS,
        rawLog(
            textIface,
            TEXT,
            "TransferSingle",
            [ALICE, ethers.constants.AddressZero, ALICE, 12, 1],
            orphanBlock,
            3
        ),
        rawLog(
            marketplaceIface,
            MARKETPLACE,
            "TokenListed",
            [TEXT, 12, ALICE, 91, 1, WVC, ethers.utils.parseUnits("1", 18)],
            orphanBlock,
            4
        ),
    ];
    const provider = fakeProvider({ logs, textUri: "data:text/plain,orphan" });

    const first = await loadIndex(provider);
    assert.equal(first.formats["text:12"], "text/plain");

    // The chain replaces that block: same token id, different content.
    provider.textUri = "data:text/markdown,canonical";
    provider.head = HEAD + 1;
    const second = await loadIndex(provider);

    assert.equal(
        second.formats["text:12"],
        "text/markdown",
        "an orphaned token's format must be re-read, not remembered"
    );
});

test("a reorg that leaves the head at the same height still drops the orphan", async () => {
    reset();
    // A reorg does not have to lengthen the chain. Block N can be replaced by a
    // different block N between two loads, and then the head the loader sees is
    // unchanged — so eventScan's "already scanned to this block" shortcut would
    // hand back the very logs the rewind just dropped, and the orphan would
    // survive the fix that exists to remove it.
    const orphan = rawLog(
        marketplaceIface,
        MARKETPLACE,
        "TokenListed",
        [TEXT, 9, ALICE, 78, 1, WVC, ethers.utils.parseUnits("1", 18)],
        HEAD - 5,
        7
    );
    const logs = [...ALL_LOGS, orphan];
    const provider = fakeProvider({ logs });

    const first = await loadIndex(provider);
    assert.equal(first.state.listings["text:9:78"]?.amount, 1);

    logs.splice(logs.indexOf(orphan), 1);
    // The head does NOT move. Everything else about the chain has.
    const cold = provider.counts.getLogs;
    const second = await loadIndex(provider);

    assert.equal(
        second.state.listings["text:9:78"],
        undefined,
        "an orphan must not survive a reorg the head height does not reveal"
    );
    assert.equal(
        provider.counts.getLogs - cold,
        3,
        "and it must cost one tail range per contract, not a fresh full pass"
    );
});
