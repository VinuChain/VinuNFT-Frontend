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
    feeLabel,
    validateBridgeTx,
    buildVinuChainRoutes,
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

// feeLabel
//
// The live VC->BNB USDT quota (pair 536), verbatim. minFeeLimit/maxFeeLimit are
// in the from-token's raw units — cross-checked against the reverse leg, where
// the same 0.2/100 USDT appear as 2e17/1e20 at 18 decimals.
const LIVE_USDT_OPERATION_FEE = {
    value: "0.004",
    isPercent: true,
    minFeeLimit: "200000",
    maxFeeLimit: "100000000",
};

test("feeLabel: the fee floor is what a minimum-size transfer actually pays", () => {
    // 0.4 USDT is the route's own minQuota. 0.4% of it is 0.0016; the floor is
    // 0.2, which is 125x more, and the percentage alone never said so.
    assert.equal(
        feeLabel(LIVE_USDT_OPERATION_FEE, 6, "USDT", decimalAmountToRaw("0.4", 6)),
        "0.2 USDT"
    );
});

test("feeLabel: the fee ceiling caps a large transfer", () => {
    assert.equal(
        feeLabel(
            LIVE_USDT_OPERATION_FEE,
            6,
            "USDT",
            decimalAmountToRaw("100000", 6)
        ),
        "100 USDT"
    );
});

test("feeLabel: between floor and ceiling the percentage is charged", () => {
    assert.equal(
        feeLabel(LIVE_USDT_OPERATION_FEE, 6, "USDT", decimalAmountToRaw("100", 6)),
        "0.4 USDT"
    );
});

test("feeLabel: with no amount entered the band is shown, not a bare percentage", () => {
    const label = feeLabel(LIVE_USDT_OPERATION_FEE, 6, "USDT", null);
    assert.ok(label.includes("0.2"), label);
    assert.ok(label.includes("100"), label);
    // "0.4% USDT" is what the page used to render: a percentage with a token
    // symbol glued on, which is not a quantity of anything.
    assert.equal(/%\s*USDT/.test(label), false, label);
});

test("feeLabel: a flat fee still carries its symbol", () => {
    assert.equal(
        feeLabel({ value: "9700000000000000000", isPercent: false }, 18, "VC"),
        "9.7 VC"
    );
});

// validateBridgeTx
const ROUTE = {
    fromChain: { chainType: "VC", chainName: "VinuChain" },
    fromToken: {
        address: "0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41",
        symbol: "USDT",
    },
};
const TARGET = "0x00000000000000000000000000000000000000bb";

test("validateBridgeTx: an approval for a token that is not the route's is rejected", () => {
    const rejection = validateBridgeTx(ROUTE, {
        tx: { to: TARGET },
        approveCheck: {
            token: "0x00000000000000000000000000000000000000aa",
            to: TARGET,
            amount: "1",
        },
    });
    assert.notEqual(rejection, null);
    assert.ok(/0x00000000000000000000000000000000000000aa/i.test(rejection), rejection);
});

test("validateBridgeTx: the route's own token, checksummed differently, is accepted", () => {
    assert.equal(
        validateBridgeTx(ROUTE, {
            tx: { to: TARGET },
            approveCheck: {
                token: ROUTE.fromToken.address.toLowerCase(),
                to: TARGET,
                amount: "1",
            },
        }),
        null
    );
});

test("validateBridgeTx: a spender off a populated allowlist is rejected", () => {
    WANBRIDGE_CONTRACTS.VC = [TARGET];
    try {
        const rejection = validateBridgeTx(ROUTE, {
            tx: { to: TARGET },
            approveCheck: {
                token: ROUTE.fromToken.address,
                to: "0x00000000000000000000000000000000deadbeef",
                amount: "1",
            },
        });
        assert.notEqual(rejection, null);
    } finally {
        delete WANBRIDGE_CONTRACTS.VC;
    }
});

// buildVinuChainRoutes: the catalog's decimals scale what the wallet signs
const USDT_ON_VC = "0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41";

function usdtPair(decimals) {
    return {
        tokenPairID: "536",
        symbol: "USDT",
        fromChain: { chainType: "VC", chainName: "VinuChain" },
        fromToken: { symbol: "USDT", decimals, address: USDT_ON_VC },
        toChain: { chainType: "BNB", chainName: "BNB Chain" },
        toToken: {
            symbol: "USDT",
            decimals: 18,
            address: "0x0000000000000000000000000000000000000055",
        },
    };
}

test("buildVinuChainRoutes: a configured VinuChain token keeps its own decimals", () => {
    assert.equal(buildVinuChainRoutes([usdtPair(6)]).length, 2);
});

test("buildVinuChainRoutes: a pair contradicting config.js decimals is dropped", () => {
    // USDT on VinuChain is 6 decimals. An upstream saying 18 would scale every
    // amount by 1e12 before the wallet ever sees it.
    assert.deepEqual(buildVinuChainRoutes([usdtPair(18)]), []);
});

test("buildVinuChainRoutes: a pair with nonsensical decimals is dropped", () => {
    assert.deepEqual(buildVinuChainRoutes([usdtPair("not-a-number")]), []);
});
