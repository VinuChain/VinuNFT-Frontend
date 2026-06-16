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
