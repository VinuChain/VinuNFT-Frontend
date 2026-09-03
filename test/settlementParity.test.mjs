import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";

const mod = await import("../src/common/settlement.js");
const { settlementBreakdown } = mod.default || mod;

/**
 * Cross-repository parity.
 *
 * The buy modal shows a fee breakdown before the user signs. If that arithmetic
 * drifts from Marketplace._handleFunds, buyers are shown a split that will not
 * happen. This fixture is not a restatement of the formula — it records the
 * balance deltas of 128 purchases that actually executed against the contract
 * (VinuNFT-Backend scripts/export_settlement_fixture.ts).
 */
const fixture = JSON.parse(readFileSync("test/fixtures-settlement.json", "utf8"));

test("the fixture comes from executed contract settlement and covers the matrix", () => {
    assert.match(fixture.generatedFrom, /_handleFunds/);
    assert.equal(fixture.cases.length, 128);
    const fees = new Set(fixture.cases.map((c) => c.platformFeeBps));
    const royalties = new Set(fixture.cases.map((c) => c.royaltyBps));
    assert.deepEqual([...fees].sort((a, b) => a - b), [0, 250, 500, 1000]);
    assert.deepEqual([...royalties].sort((a, b) => a - b), [0, 250, 1000, 10000]);
});

test("every leg the frontend would display matches what the contract paid", () => {
    const mismatches = [];
    for (const c of fixture.cases) {
        const predicted = settlementBreakdown({
            total: ethers.BigNumber.from(c.total),
            platformFeeBps: c.platformFeeBps,
            royaltyAmount: ethers.BigNumber.from(c.quotedRoyaltyOnRemainder),
            royaltyReceiver: c.royaltyReceiver,
        });
        for (const leg of ["platformFee", "creatorFee", "sellerProceeds"]) {
            if (predicted[leg].toString() !== c.actual[leg]) {
                mismatches.push(
                    `total=${c.total} fee=${c.platformFeeBps}bps royalty=${c.royaltyBps}bps ` +
                        `${leg}: predicted ${predicted[leg]} but the contract paid ${c.actual[leg]}`
                );
            }
        }
    }
    assert.deepEqual(mismatches, []);
});

test("the contract's own settlement is exact in every recorded case", () => {
    // If this failed, the contract would be losing or inventing value.
    for (const c of fixture.cases) {
        const summed =
            BigInt(c.actual.platformFee) +
            BigInt(c.actual.creatorFee) +
            BigInt(c.actual.sellerProceeds);
        assert.equal(summed.toString(), c.total, `legs must sum to the price for ${c.total}`);
    }
});

test("a 100% royalty leaves the seller nothing but never goes negative", () => {
    const extreme = fixture.cases.filter((c) => c.royaltyBps === 10000);
    assert.ok(extreme.length > 0);
    for (const c of extreme) {
        assert.equal(c.actual.sellerProceeds, "0", `seller should net zero at ${c.total}`);
        assert.ok(BigInt(c.actual.creatorFee) >= 0n);
    }
});
