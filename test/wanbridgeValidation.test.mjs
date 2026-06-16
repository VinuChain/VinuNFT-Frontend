import { test } from "node:test";
import assert from "node:assert/strict";
import * as _mod from "../src/common/wanbridgeValidation.js";

// tsx CJS-interop: named exports land on the .default namespace object
const {
    isChainType,
    isPositiveDecimal,
    isEvmWanBridgeChain,
    isDestinationAccount,
    isTokenIdentifier,
} = _mod.default || _mod;

// isChainType
test("isChainType: valid short codes", () => {
    assert.equal(isChainType("VC"), true);
    assert.equal(isChainType("BNB"), true);
    assert.equal(isChainType("ETH"), true);
});

test("isChainType: empty string returns false", () => {
    assert.equal(isChainType(""), false);
});

test("isChainType: single char returns false (min 2)", () => {
    assert.equal(isChainType("x"), false);
});

test("isChainType: bad chars returns false", () => {
    assert.equal(isChainType("toolongchaintype!"), false);
});

// isPositiveDecimal
test("isPositiveDecimal: integer string", () => {
    assert.equal(isPositiveDecimal("1"), true);
});

test("isPositiveDecimal: decimal with leading digit", () => {
    assert.equal(isPositiveDecimal("0.5"), true);
});

test("isPositiveDecimal: decimal without leading digit", () => {
    assert.equal(isPositiveDecimal(".5"), true);
});

test("isPositiveDecimal: zero returns false", () => {
    assert.equal(isPositiveDecimal("0"), false);
});

test("isPositiveDecimal: negative returns false", () => {
    assert.equal(isPositiveDecimal("-1"), false);
});

test("isPositiveDecimal: non-numeric returns false", () => {
    assert.equal(isPositiveDecimal("abc"), false);
});

test("isPositiveDecimal: empty string returns false", () => {
    assert.equal(isPositiveDecimal(""), false);
});

// isEvmWanBridgeChain
test("isEvmWanBridgeChain: ETH is EVM", () => {
    assert.equal(isEvmWanBridgeChain("ETH"), true);
});

test("isEvmWanBridgeChain: VC is EVM", () => {
    assert.equal(isEvmWanBridgeChain("VC"), true);
});

test("isEvmWanBridgeChain: BTC is not EVM", () => {
    assert.equal(isEvmWanBridgeChain("BTC"), false);
});

test("isEvmWanBridgeChain: SOL is not EVM", () => {
    assert.equal(isEvmWanBridgeChain("SOL"), false);
});

test("isEvmWanBridgeChain: empty string returns false", () => {
    assert.equal(isEvmWanBridgeChain(""), false);
});

// isDestinationAccount
const VALID_EVM_ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

test("isDestinationAccount: valid 0x address with EVM chain returns true", () => {
    assert.equal(isDestinationAccount(VALID_EVM_ADDR, "ETH"), true);
});

test("isDestinationAccount: EVM address with BTC chain returns false", () => {
    assert.equal(isDestinationAccount(VALID_EVM_ADDR, "BTC"), false);
});

test("isDestinationAccount: plausible BTC address with BTC chain returns true", () => {
    assert.equal(
        isDestinationAccount("1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf", "BTC"),
        true
    );
});

test("isDestinationAccount: missing value returns false", () => {
    assert.equal(isDestinationAccount("", "ETH"), false);
});

test("isDestinationAccount: missing chain returns false", () => {
    assert.equal(isDestinationAccount(VALID_EVM_ADDR, ""), false);
});

// isTokenIdentifier
test("isTokenIdentifier: 0x address with EVM chain returns true", () => {
    assert.equal(isTokenIdentifier(VALID_EVM_ADDR, "ETH"), true);
});

test("isTokenIdentifier: short non-address with non-EVM chain returns true", () => {
    assert.equal(isTokenIdentifier("USDT", "BTC"), true);
});

test("isTokenIdentifier: empty value returns false", () => {
    assert.equal(isTokenIdentifier("", "ETH"), false);
});
