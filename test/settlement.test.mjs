import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

const mod = await import("../src/common/settlement.js");
const { settlementBreakdown, bpsToPercent } = mod.default || mod;

const BN = (n) => ethers.BigNumber.from(String(n));
const ZERO = ethers.constants.AddressZero;
const CREATOR = "0x12BD0b15D5010De455DCe7944265Fe1D35a84023";

/** The invariant the contract guarantees: the legs are exactly the price. */
function assertExact(result, total, label) {
    const summed = result.platformFee.add(result.creatorFee).add(result.sellerProceeds);
    assert.equal(
        summed.toString(),
        BN(total).toString(),
        `${label}: legs sum to ${summed} not ${total}`
    );
    for (const [leg, value] of Object.entries(result)) {
        assert.ok(value.gte(0), `${label}: ${leg} went negative`);
    }
}

test("the default 5% fee splits a round price the way the contract does", () => {
    const r = settlementBreakdown({ total: BN(10000), platformFeeBps: 500 });
    assert.equal(r.platformFee.toString(), "500");
    assert.equal(r.creatorFee.toString(), "0");
    assert.equal(r.sellerProceeds.toString(), "9500");
    assertExact(r, 10000, "round price");
});

test("the royalty is taken from the remainder, not from the original price", () => {
    // 10% of the post-fee remainder (9500) is 950, not 10% of 10000.
    const remainder = 9500;
    const r = settlementBreakdown({
        total: BN(10000),
        platformFeeBps: 500,
        royaltyAmount: BN(Math.floor(remainder * 0.1)),
        royaltyReceiver: CREATOR,
    });
    assert.equal(r.platformFee.toString(), "500");
    assert.equal(r.creatorFee.toString(), "950");
    assert.equal(r.sellerProceeds.toString(), "8550");
    assertExact(r, 10000, "royalty on remainder");
});

test("legs sum exactly at prices where integer division truncates", () => {
    // The prices the contract's own invariant suite uses, plus awkward ones.
    for (const total of [1, 3, 7, 19, 99, 100, 333, 1001, 999999, 1, 2]) {
        for (const bps of [0, 1, 250, 500, 999, 1000]) {
            const remainder = BN(total).sub(BN(total).mul(bps).div(10000));
            for (const royaltyBps of [0, 250, 1000, 10000]) {
                const r = settlementBreakdown({
                    total: BN(total),
                    platformFeeBps: bps,
                    royaltyAmount: remainder.mul(royaltyBps).div(10000),
                    royaltyReceiver: CREATOR,
                });
                assertExact(r, total, `total=${total} bps=${bps} royalty=${royaltyBps}`);
            }
        }
    }
});

test("a royalty larger than the remainder is clamped, and the seller gets nothing rather than a negative", () => {
    const r = settlementBreakdown({
        total: BN(1000),
        platformFeeBps: 500,
        royaltyAmount: BN(100000),
        royaltyReceiver: CREATOR,
    });
    assert.equal(r.platformFee.toString(), "50");
    assert.equal(r.creatorFee.toString(), "950");
    assert.equal(r.sellerProceeds.toString(), "0");
    assertExact(r, 1000, "clamped royalty");
});

test("a royalty to the zero address stays with the seller", () => {
    // Matches the contract: it skips the payout rather than burning the fee.
    const r = settlementBreakdown({
        total: BN(1000),
        platformFeeBps: 500,
        royaltyAmount: BN(500),
        royaltyReceiver: ZERO,
    });
    assert.equal(r.creatorFee.toString(), "0");
    assert.equal(r.sellerProceeds.toString(), "950");
    assertExact(r, 1000, "zero-address royalty");
});

test("a zero platform fee gives the seller everything not owed to the creator", () => {
    const r = settlementBreakdown({ total: BN(19), platformFeeBps: 0 });
    assert.equal(r.platformFee.toString(), "0");
    assert.equal(r.sellerProceeds.toString(), "19");
    assertExact(r, 19, "zero fee");
});

test("a price of 1 with a 5% fee rounds the fee to zero, not up", () => {
    // Integer division truncates; the seller must not be charged a rounded-up fee.
    const r = settlementBreakdown({ total: BN(1), platformFeeBps: 500 });
    assert.equal(r.platformFee.toString(), "0");
    assert.equal(r.sellerProceeds.toString(), "1");
    assertExact(r, 1, "price of one");
});

test("missing royalty information is treated as no royalty", () => {
    const r = settlementBreakdown({ total: BN(1000), platformFeeBps: 500 });
    assert.equal(r.creatorFee.toString(), "0");
    assertExact(r, 1000, "absent royalty");
});

test("basis points render as a percentage", () => {
    assert.equal(bpsToPercent(500), "5");
    assert.equal(bpsToPercent(1000), "10");
    assert.equal(bpsToPercent(250), "2.5");
    assert.equal(bpsToPercent(0), "0");
});
