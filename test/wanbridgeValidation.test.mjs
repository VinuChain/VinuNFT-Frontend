import { test } from "node:test";
import assert from "node:assert/strict";
import * as _mod from "../src/common/wanbridgeValidation.js";
import * as _bridge from "../src/common/wanbridge.js";

// tsx CJS-interop: named exports land on the .default namespace object
const {
    isChainType,
    isPositiveDecimal,
    isEvmWanBridgeChain,
    isDestinationAccount,
    isTokenIdentifier,
    canValidateDestinationChain,
} = _mod.default || _mod;
const { BRIDGE_EVM_CHAINS } = _bridge.default || _bridge;

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

// XPL (Plasma, chain 9745) is live in the WanBridge catalog — pair 1209, USDT,
// quotable in both directions — and is in neither of the app's chain lists. On
// the VC->XPL leg, which the app will sign, the destination is hand-typed
// because the chain is unrecognised, and the old catch-all regex accepted
// anything vaguely address-shaped.
const TRUNCATED_EVM_ADDRESS = "0x12BD0b15D5010De455DCe7944265Fe1D35a840";

test("isDestinationAccount: a truncated EVM address on an unknown chain is refused", () => {
    assert.equal(isDestinationAccount(TRUNCATED_EVM_ADDRESS, "XPL"), false);
});

test("isDestinationAccount: arbitrary text on an unknown chain is refused", () => {
    assert.equal(isDestinationAccount("not-an-address", "XPL"), false);
});

test("isDestinationAccount: a real EVM address on a known EVM chain still passes", () => {
    // The fix must fail closed, not blanket-false.
    assert.equal(isDestinationAccount(VALID_EVM_ADDR, "BNB"), true);
});

test("isDestinationAccount: a chain type colliding with Object.prototype is refused", () => {
    assert.equal(isDestinationAccount(VALID_EVM_ADDR, "constructor"), false);
});

test("canValidateDestinationChain: unknown chains are not signable in-app", () => {
    assert.equal(canValidateDestinationChain("XPL"), false);
    assert.equal(canValidateDestinationChain("BNB"), true);
    assert.equal(canValidateDestinationChain("BTC"), true);
});

test("the EVM chain list is derived from the bridge chain registry, not copied", () => {
    // A second hardcoded list is exactly how XPL became EVM-in-fact and
    // unknown-in-code; this fails the moment one is reintroduced.
    for (const chain of BRIDGE_EVM_CHAINS) {
        assert.equal(
            isEvmWanBridgeChain(chain.chainType),
            true,
            `${chain.chainType} is in BRIDGE_EVM_CHAINS but not treated as EVM`
        );
    }
});
