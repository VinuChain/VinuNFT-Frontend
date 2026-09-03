import assert from "node:assert/strict";
import test from "node:test";
import { diffInvariants, loadPins } from "../scripts/deployed-invariants.mjs";

const pinned = loadPins();

/** The live values as verify-deployed-truth.mjs captures them, unmutated. */
const asPinned = () =>
    Object.fromEntries(
        Object.entries(pinned)
            .filter(([name]) => !name.startsWith("_"))
            .map(([name, pin]) => [
                name,
                { codeHash: pin.codeHash, views: { ...(pin.views ?? {}) } },
            ])
    );

test("chain state matching the pin reports no drift", () => {
    assert.deepEqual(diffInvariants(asPinned(), pinned), []);
});

test("every admin lever moving is reported, one line each", () => {
    const actual = asPinned();
    actual.marketplace.views.paused = "true";
    actual.marketplace.views.platformFeePercentage = "1000";
    actual.marketplace.views.commissionAccount =
        "0xdEaD000000000000000000000000000000000000";
    actual.marketplace.views.PLATFORM_FEE_TIMELOCK = "3600";
    actual.image.codeHash = `0x${"11".repeat(32)}`;

    const diffs = diffInvariants(actual, pinned);
    assert.equal(diffs.length, 5, diffs.join("\n"));
    assert.match(
        diffs.join("\n"),
        /platformFeePercentage: pinned 500, chain reports 1000/
    );
    assert.match(diffs.join("\n"), /paused: pinned false, chain reports true/);
    assert.match(
        diffs.join("\n"),
        /commissionAccount: pinned 0x12BD0b15D5010De455DCe7944265Fe1D35a84023, chain reports 0xdEaD/
    );
    assert.match(
        diffs.join("\n"),
        /PLATFORM_FEE_TIMELOCK: pinned 604800, chain reports 3600/
    );
    assert.match(diffs.join("\n"), /image: deployed bytecode hash changed/);
});

test("a pinned view that stops answering is drift, not silence", () => {
    const actual = asPinned();
    delete actual.marketplace.views.owner;
    assert.deepEqual(diffInvariants(actual, pinned), [
        "marketplace.owner: pinned 0x12BD0b15D5010De455DCe7944265Fe1D35a84023, but the call no longer answers",
    ]);
});

// The reason pinning is by explicit key: a generic "pin every zero-arg view"
// scheme would pin lastTokenId and red-light the gate on every legitimate mint.
test("no value that legitimately moves is pinned", () => {
    for (const [name, pin] of Object.entries(pinned)) {
        if (name.startsWith("_")) continue;
        assert.ok(
            !("lastTokenId" in (pin.views ?? {})),
            `${name} pins lastTokenId, which changes on every mint`
        );
    }
});

test("the pin covers the levers the marketplace owner can pull", () => {
    for (const fn of [
        "paused",
        "platformFeePercentage",
        "commissionAccount",
        "owner",
        "lock",
        "newPlatformFeePercentage",
        "PLATFORM_FEE_TIMELOCK",
    ]) {
        assert.ok(fn in pinned.marketplace.views, `marketplace.${fn} is not pinned`);
    }
    for (const name of ["marketplace", "text", "image"]) {
        assert.match(pinned[name].codeHash, /^0x[0-9a-f]{64}$/);
    }
});
