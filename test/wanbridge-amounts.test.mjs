import { test } from "node:test";
import assert from "node:assert/strict";
import * as _mod from "../src/common/wanbridge.js";

// tsx CJS-interop: named exports land on the .default namespace object
const {
    decimalAmountToRaw,
    isPositiveDecimalAmount,
    isAmountWithinQuota,
    priorityRank,
    toHexChainId,
    isKnownBridgeTarget,
    WANBRIDGE_CONTRACTS,
} = _mod.default || _mod;

// decimalAmountToRaw
test("decimalAmountToRaw: 1.5 with 18 decimals produces correct raw value", () => {
    const result = decimalAmountToRaw("1.5", 18);
    assert.notEqual(result, null);
    assert.equal(result.toString(), "1500000000000000000");
});

test("decimalAmountToRaw: zero returns null", () => {
    assert.equal(decimalAmountToRaw("0", 18), null);
});

test("decimalAmountToRaw: non-numeric returns null", () => {
    assert.equal(decimalAmountToRaw("abc", 18), null);
});

test("decimalAmountToRaw: whitespace-padded valid amount is accepted", () => {
    const result = decimalAmountToRaw(" 2 ", 18);
    assert.notEqual(result, null);
    assert.equal(result.toString(), "2000000000000000000");
});

// isPositiveDecimalAmount
test("isPositiveDecimalAmount: '1' returns true", () => {
    assert.equal(isPositiveDecimalAmount("1"), true);
});

test("isPositiveDecimalAmount: '0' returns false", () => {
    assert.equal(isPositiveDecimalAmount("0"), false);
});

test("isPositiveDecimalAmount: '-1' returns false", () => {
    assert.equal(isPositiveDecimalAmount("-1"), false);
});

// toHexChainId
test("toHexChainId: 207 (VinuChain) encodes to 0xcf", () => {
    assert.equal(toHexChainId(207), "0xcf");
});

test("toHexChainId: 1 (Ethereum) encodes to 0x1", () => {
    assert.equal(toHexChainId(1), "0x1");
});

// priorityRank
test("priorityRank: USDT is rank 0 (highest priority)", () => {
    assert.equal(priorityRank("USDT"), 0);
});

test("priorityRank: VINU is rank 1", () => {
    assert.equal(priorityRank("VINU"), 1);
});

test("priorityRank: VC is rank 2", () => {
    assert.equal(priorityRank("VC"), 2);
});

test("priorityRank: unknown symbol gets last rank", () => {
    assert.equal(priorityRank("UNKNOWN"), 4);
});

// isAmountWithinQuota
test("isAmountWithinQuota: 5 within [1, 10] returns true", () => {
    assert.equal(
        isAmountWithinQuota("5", 0, { minQuota: "1", maxQuota: "10" }),
        true
    );
});

test("isAmountWithinQuota: 0.5 below min quota returns false", () => {
    assert.equal(
        isAmountWithinQuota("0.5", 0, { minQuota: "1", maxQuota: "10" }),
        false
    );
});

test("isAmountWithinQuota: 100 above max quota returns false", () => {
    assert.equal(
        isAmountWithinQuota("100", 0, { minQuota: "1", maxQuota: "10" }),
        false
    );
});

test("isAmountWithinQuota: zero max quota returns false", () => {
    assert.equal(
        isAmountWithinQuota("5", 0, { minQuota: "1", maxQuota: "0" }),
        false
    );
});

// isKnownBridgeTarget
test("isKnownBridgeTarget: known address on a catalogued chain returns true", () => {
    // Temporarily populate the map for this test
    const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
    WANBRIDGE_CONTRACTS["TEST"] = [addr];
    assert.equal(isKnownBridgeTarget("TEST", addr), true);
    delete WANBRIDGE_CONTRACTS["TEST"];
});

test("isKnownBridgeTarget: known address comparison is case-insensitive", () => {
    const addr = "0xABCDEF1234567890abcdef1234567890abcdef12";
    WANBRIDGE_CONTRACTS["TEST"] = [addr.toLowerCase()];
    assert.equal(isKnownBridgeTarget("TEST", addr), true);
    delete WANBRIDGE_CONTRACTS["TEST"];
});

test("isKnownBridgeTarget: unknown address on a catalogued chain returns false", () => {
    WANBRIDGE_CONTRACTS["TEST"] = ["0x1111111111111111111111111111111111111111"];
    assert.equal(
        isKnownBridgeTarget("TEST", "0x2222222222222222222222222222222222222222"),
        false
    );
    delete WANBRIDGE_CONTRACTS["TEST"];
});

test("isKnownBridgeTarget: uncatalogued chain returns null", () => {
    // Ensure no entry exists for UNCATALOGUED
    delete WANBRIDGE_CONTRACTS["UNCATALOGUED"];
    assert.equal(
        isKnownBridgeTarget("UNCATALOGUED", "0x1234567890123456789012345678901234567890"),
        null
    );
});

test("isKnownBridgeTarget: empty list for chain returns null", () => {
    WANBRIDGE_CONTRACTS["EMPTY"] = [];
    assert.equal(
        isKnownBridgeTarget("EMPTY", "0x1234567890123456789012345678901234567890"),
        null
    );
    delete WANBRIDGE_CONTRACTS["EMPTY"];
});
