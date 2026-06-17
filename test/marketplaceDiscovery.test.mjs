import { test } from "node:test";
import assert from "node:assert/strict";
import * as _mod from "../src/common/marketplaceDiscovery.js";

// tsx CJS-interop: named exports land on the .default namespace object
const { tokenIdsFromLatest, rowMatchesFilters } = _mod.default || _mod;

// ---------------------------------------------------------------------------
// tokenIdsFromLatest
// ---------------------------------------------------------------------------

test("tokenIdsFromLatest(12, 12) returns [12..1]", () => {
    const result = tokenIdsFromLatest(12, 12);
    assert.deepEqual(result, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test("tokenIdsFromLatest(3, 12) clamps at 1 — returns [3,2,1]", () => {
    const result = tokenIdsFromLatest(3, 12);
    assert.deepEqual(result, [3, 2, 1]);
});

test("tokenIdsFromLatest: no zero or negative ids", () => {
    const result = tokenIdsFromLatest(2, 10);
    assert.ok(result.every((id) => id >= 1));
    assert.deepEqual(result, [2, 1]);
});

test("tokenIdsFromLatest(1, 5) returns [1]", () => {
    assert.deepEqual(tokenIdsFromLatest(1, 5), [1]);
});

test("tokenIdsFromLatest(0, 5) returns [] (no valid ids)", () => {
    assert.deepEqual(tokenIdsFromLatest(0, 5), []);
});

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
