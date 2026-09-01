import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("../src/common/utils.js");
const { exceedsTokenDecimals } = mod.default || mod;

test("a 7-decimal price does not fit a 6-decimal token", () => {
    assert.equal(exceedsTokenDecimals("0.0000001", "usdt"), true);
});

test("a 6-decimal price fits a 6-decimal token", () => {
    assert.equal(exceedsTokenDecimals("0.000001", "usdt"), false);
});

test("the same 7-decimal price fits an 18-decimal token", () => {
    assert.equal(exceedsTokenDecimals("0.0000001", "wvc"), false);
});

test("a whole number and a trailing point carry no fraction", () => {
    assert.equal(exceedsTokenDecimals("12", "usdt"), false);
    assert.equal(exceedsTokenDecimals("12.", "usdt"), false);
});

test("an unknown token is not this check's business", () => {
    assert.equal(exceedsTokenDecimals("0.0000001", "nope"), false);
});

const { estimateFee } = mod.default || mod;
const { ethers } = await import("ethers");

const gasPriceOf = (wei) => ({
    getGasPrice: async () => ethers.BigNumber.from(wei),
});

test("the fee is gas times gas price, in the native currency", async () => {
    // 200000 gas at 5 gwei
    const fee = await estimateFee(
        async () => ethers.BigNumber.from(200000),
        gasPriceOf("5000000000")
    );

    assert.equal(fee, "0.001");
});

test("an estimate the node refuses is null, never zero", async () => {
    const fee = await estimateFee(async () => {
        throw new Error("execution reverted");
    }, gasPriceOf("5000000000"));

    assert.equal(fee, null);
});

test("a gas price the node refuses is null too", async () => {
    const fee = await estimateFee(async () => ethers.BigNumber.from(21000), {
        getGasPrice: async () => {
            throw new Error("no");
        },
    });

    assert.equal(fee, null);
});
