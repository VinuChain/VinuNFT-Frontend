import { test } from "node:test";
import assert from "node:assert/strict";
import * as _mod from "../src/common/marketplaceDiscovery.js";

// tsx CJS-interop: named exports land on the .default namespace object
const {
    rowMatchesFilters,
    compareListingRows,
    pageListings,
} =
    _mod.default || _mod;

// ---------------------------------------------------------------------------
// rowMatchesFilters
// ---------------------------------------------------------------------------

const baseRow = {
    nftType: "text",
    paymentToken: "USDT",
    sellerBalance: 10,
    amount: 5,
    seller: "0x1234567890123456789012345678901234567890",
};

test("rowMatchesFilters: empty filters — passthrough", () => {
    assert.equal(rowMatchesFilters(baseRow, {}), true);
});

test("rowMatchesFilters: nftType match", () => {
    assert.equal(rowMatchesFilters(baseRow, { nftType: "text" }), true);
});

test("rowMatchesFilters: nftType mismatch", () => {
    assert.equal(rowMatchesFilters(baseRow, { nftType: "image" }), false);
});

test("rowMatchesFilters: nftType 'all' passes through", () => {
    assert.equal(rowMatchesFilters(baseRow, { nftType: "all" }), true);
});

test("rowMatchesFilters: paymentToken match", () => {
    assert.equal(rowMatchesFilters(baseRow, { paymentToken: "USDT" }), true);
});

test("rowMatchesFilters: paymentToken mismatch", () => {
    assert.equal(rowMatchesFilters(baseRow, { paymentToken: "VINU" }), false);
});

test("rowMatchesFilters: paymentToken 'all' passes through", () => {
    assert.equal(rowMatchesFilters(baseRow, { paymentToken: "all" }), true);
});

test("rowMatchesFilters: fulfillableOnly — sellerBalance >= amount passes", () => {
    const row = { ...baseRow, sellerBalance: 5, amount: 5 };
    assert.equal(rowMatchesFilters(row, { fulfillableOnly: true }), true);
});

test("rowMatchesFilters: fulfillableOnly — sellerBalance < amount fails", () => {
    const row = { ...baseRow, sellerBalance: 3, amount: 5 };
    assert.equal(rowMatchesFilters(row, { fulfillableOnly: true }), false);
});

test("rowMatchesFilters: fulfillableOnly — null sellerBalance passes (unknown)", () => {
    const row = { ...baseRow, sellerBalance: null };
    assert.equal(rowMatchesFilters(row, { fulfillableOnly: true }), true);
});

test("rowMatchesFilters: seller match (checksummed)", () => {
    assert.equal(
        rowMatchesFilters(baseRow, {
            seller: "0x1234567890123456789012345678901234567890",
        }),
        true
    );
});

test("rowMatchesFilters: seller mismatch", () => {
    assert.equal(
        rowMatchesFilters(baseRow, {
            seller: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
        }),
        false
    );
});

test("rowMatchesFilters: invalid seller address in filter returns false", () => {
    assert.equal(rowMatchesFilters(baseRow, { seller: "not-an-address" }), false);
});

// ---------------------------------------------------------------------------
// compareListingRows
// ---------------------------------------------------------------------------

const priceRow = (price, extra = {}) => ({
    nftType: "text",
    tokenId: 1,
    listingId: 0,
    price,
    ...extra,
});

test("compareListingRows: 18-decimal prices below float resolution still order", () => {
    // parseFloat collapses these two to the same double, so a float comparator
    // returns 0 and the stable sort keeps the contradicting input order.
    const cheap = priceRow("1.000000000000000001", { listingId: 0 });
    const dear = priceRow("1.000000000000000002", { listingId: 1 });
    const sorted = [dear, cheap].sort(compareListingRows);
    assert.deepEqual(
        sorted.map((r) => r.price),
        ["1.000000000000000001", "1.000000000000000002"]
    );
});

test("compareListingRows: prices are compared across token decimals, not raw units", () => {
    // 1 USDT (6 decimals) must not outrank 100 WVC (18 decimals); rows carry
    // the already-normalised decimal string, which is why this holds.
    const usdt = priceRow("1.0", { paymentToken: "usdt", listingId: 0 });
    const wvc = priceRow("100.0", { paymentToken: "wvc", listingId: 1 });
    assert.deepEqual(
        [wvc, usdt].sort(compareListingRows).map((r) => r.price),
        ["1.0", "100.0"]
    );
});

test("compareListingRows: equal prices fall back to a deterministic key", () => {
    const a = priceRow("5.0", { nftType: "text", tokenId: 2, listingId: 1 });
    const b = priceRow("5.0", { nftType: "text", tokenId: 2, listingId: 0 });
    const c = priceRow("5.0", { nftType: "image", tokenId: 9, listingId: 0 });
    const key = (r) => `${r.nftType}:${r.tokenId}:${r.listingId}`;
    // Same rows in any input order must produce the same output order.
    assert.deepEqual(
        [a, b, c].sort(compareListingRows).map(key),
        [c, b, a].sort(compareListingRows).map(key)
    );
});

test("compareListingRows: an unparseable price sorts last rather than throwing", () => {
    const good = priceRow("1.0");
    const bad = priceRow(null, { listingId: 1 });
    assert.deepEqual(
        [bad, good].sort(compareListingRows).map((r) => r.price),
        ["1.0", null]
    );
});

// ---------------------------------------------------------------------------
// compareListingRows: currencies are never interleaved
// ---------------------------------------------------------------------------

test("compareListingRows: mixed payment tokens group, they do not interleave", () => {
    // Numerically the three normalised prices order 1 < 5 < 10, which puts the
    // WVC row between the two USDT rows and invites the reader to compare a
    // WVC number with a USDT one. No price feed exists (VN-PRICE-001), so the
    // only honest ordering keeps each currency contiguous.
    const rows = [
        priceRow("5.0", { paymentToken: "usdt", tokenId: 1, listingId: 0 }),
        priceRow("1.0", { paymentToken: "wvc", tokenId: 2, listingId: 0 }),
        priceRow("10.0", { paymentToken: "usdt", tokenId: 3, listingId: 0 }),
    ];
    assert.deepEqual(
        [...rows].sort(compareListingRows).map((r) => r.paymentToken),
        ["usdt", "usdt", "wvc"]
    );
});

test("compareListingRows: within one token, raw units decide, not the formatted string", () => {
    // 6-decimal USDT: 1.000001 and 1.000002 are one base unit apart. The rows
    // carry the raw amount precisely so the comparator never has to re-parse.
    const cheap = priceRow("1.000001", {
        paymentToken: "usdt",
        priceRaw: "1000001",
        listingId: 0,
    });
    const dear = priceRow("1.000002", {
        paymentToken: "usdt",
        priceRaw: "1000002",
        listingId: 1,
    });
    assert.ok(compareListingRows(cheap, dear) < 0);
    assert.ok(compareListingRows(dear, cheap) > 0);
});

test("compareListingRows: a row with no price sorts after every priced row", () => {
    const priced = priceRow("1.0", { paymentToken: "wvc", priceRaw: "1000000000000000000" });
    const unpriced = priceRow(null, {
        paymentToken: null,
        priceRaw: null,
        listingId: 1,
    });
    assert.deepEqual(
        [unpriced, priced].sort(compareListingRows).map((r) => r.price),
        ["1.0", null]
    );
});

// ---------------------------------------------------------------------------
// rowMatchesFilters: search
// ---------------------------------------------------------------------------

const searchRow = {
    ...baseRow,
    tokenId: 1,
    seller: "0x12BD0b15D5010De455DCe7944265Fe1D35a84023",
};

test("rowMatchesFilters: a digits query matches the token id exactly, not by prefix", () => {
    // The load-bearing case: token 11 must NOT answer a search for token 1.
    assert.equal(
        rowMatchesFilters({ ...searchRow, tokenId: 11 }, { query: "1" }),
        false
    );
    assert.equal(rowMatchesFilters(searchRow, { query: "1" }), true);
});

test("rowMatchesFilters: a 0x query matches the seller by prefix and excludes others", () => {
    assert.equal(
        rowMatchesFilters(
            { ...searchRow, seller: "0x9abc567890123456789012345678901234567890" },
            { query: "0x12BD" }
        ),
        false
    );
    assert.equal(rowMatchesFilters(searchRow, { query: "0x12bd" }), true);
});

test("rowMatchesFilters: an empty query filters nothing", () => {
    assert.equal(rowMatchesFilters(searchRow, { query: "  " }), true);
});

// ---------------------------------------------------------------------------
// pageListings
// ---------------------------------------------------------------------------

const pageRows = Array.from({ length: 5 }, (_, i) => ({
    nftType: "text",
    tokenId: i + 1,
    listingId: 0,
    paymentToken: "wvc",
    price: "1.0",
    priceRaw: "1000000000000000000",
}));

test("pageListings: the first page is bounded and reports what is left", () => {
    const page = pageListings(pageRows, { pageSize: 2 });
    assert.deepEqual(page.rows.map((r) => r.tokenId), [1, 2]);
    assert.equal(page.nextCursor, "text:2:0");
    assert.equal(page.remaining, 3);
});

test("pageListings: the cursor is a listing identity, so an inserted row cannot push one off the page", () => {
    const first = pageListings(pageRows, { pageSize: 2 });
    // A cheaper listing arrives at the head of the sorted set between renders.
    const withNewHead = [
        { nftType: "text", tokenId: 99, listingId: 0, paymentToken: "wvc", price: "0.1", priceRaw: "100000000000000000" },
        ...pageRows,
    ];
    const second = pageListings(withNewHead, {
        cursor: first.nextCursor,
        pageSize: 2,
    });
    // An offset of 4 would have started at token 3 and dropped tokens 99 and 1.
    assert.deepEqual(
        second.rows.map((r) => r.tokenId),
        [99, 1, 2, 3, 4]
    );
    assert.equal(second.nextCursor, "text:4:0");
});

test("pageListings: the last page reports no cursor", () => {
    const page = pageListings(pageRows, { cursor: "text:3:0", pageSize: 2 });
    assert.equal(page.rows.length, 5);
    assert.equal(page.nextCursor, null);
    assert.equal(page.remaining, 0);
});

test("pageListings: a cursor that no longer matches any row restarts at the top", () => {
    // queryEvents returns an empty page for an unknown cursor. Here that would
    // blank the marketplace after a filter change, so the page restarts instead.
    const page = pageListings(pageRows, { cursor: "text:404:0", pageSize: 2 });
    assert.deepEqual(page.rows.map((r) => r.tokenId), [1, 2]);
});

test("compareListingRows: high-to-low keeps unpriced listings last", () => {
    // Multiplying the whole comparator by -1 reversed its null handling too, so
    // a listing in a token this app cannot price — the one row whose price is
    // unstated — jumped ahead of every priced listing on "High to low".
    const unpriced = priceRow(null, { paymentToken: null, listingId: 2 });
    const cheap = priceRow("1.0", { paymentToken: "wvc", listingId: 0 });
    const dear = priceRow("9.0", { paymentToken: "wvc", listingId: 1 });

    const descending = (l, r) => compareListingRows(l, r, { descending: true });
    assert.deepEqual(
        [cheap, unpriced, dear].sort(descending).map((r) => r.price),
        ["9.0", "1.0", null]
    );
    // And the ascending order is unchanged.
    assert.deepEqual(
        [dear, unpriced, cheap].sort(compareListingRows).map((r) => r.price),
        ["1.0", "9.0", null]
    );
});
