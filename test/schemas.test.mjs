import { test } from "node:test";
import assert from "node:assert/strict";
import * as _mod from "../src/common/schemas.js";

// tsx CJS-interop: "export default {...}" lands on .default.default when
// the source file itself has no "type":"module" and tsx wraps it in CJS.
const _top = _mod.default || _mod;
const schemas = _top.default || _top;

// etherValidator exercised via schemas.list

test("schemas.list: valid integer price passes", () => {
    const result = schemas.list.validate({
        amount: 1,
        price: "5",
        paymentToken: "USDT",
    });
    assert.equal(result.error, undefined);
});

test("schemas.list: trailing-dot price does not throw (plan-007 regression)", () => {
    // Before the etherValidator fix this threw TypeError from .splice
    let result;
    assert.doesNotThrow(() => {
        result = schemas.list.validate({
            amount: 1,
            price: "5.",
            paymentToken: "USDT",
        });
    });
    assert.ok(result !== undefined, "validate returned a result object");
});

test("schemas.list: 19-decimal price sets error (over-18-decimals)", () => {
    const result = schemas.list.validate({
        amount: 1,
        price: "1.1234567890123456789",
        paymentToken: "USDT",
    });
    assert.ok(result.error !== undefined, "expected a validation error");
});

test("schemas.validMarkdown.protocols.src does not include data URIs", () => {
    const src = schemas.validMarkdown?.protocols?.src ?? [];
    assert.equal(
        src.includes("data"),
        false,
        "validMarkdown must not allow data: URIs in src to prevent data-URI XSS"
    );
});

// The transfer recipient used to reuse the mint form's conditional rule, whose
// condition no other form sets, so every string was accepted.

for (const bad of ["not-an-address", "0x123", "0xdeadbeef", "vinu.com", ""]) {
    test(`schemas.transfer: rejects recipient ${JSON.stringify(bad)}`, () => {
        const result = schemas.transfer.validate({ to: bad, amount: 1 });
        assert.ok(result.error !== undefined, "expected a validation error");
        assert.match(
            result.error.message,
            /valid Ethereum name or address/,
            "the message must say what a valid recipient looks like"
        );
    });
}

test("schemas.transfer: rejects a missing recipient", () => {
    const result = schemas.transfer.validate({ amount: 1 });
    assert.ok(result.error !== undefined, "expected a validation error");
    assert.match(result.error.message, /valid Ethereum name or address/);
});

for (const good of [
    "0x12BD0b15D5010De455DCe7944265Fe1D35a84023",
    "nobody.eth",
]) {
    test(`schemas.transfer: accepts recipient ${good}`, () => {
        const result = schemas.transfer.validate({ to: good, amount: 1 });
        assert.equal(result.error, undefined);
        assert.equal(result.value.to, good);
    });
}

// The mint form shares the rule but keeps its toggle, and must be unaffected.

test("schemas.mint: custom recipient still ignored while the toggle is off", () => {
    const result = schemas.mint.validate({
        editionSize: 1,
        royaltyPercentage: 5,
        useCustomRecipient: false,
        customRecipient: "",
        dataType: "text/plain",
    });
    assert.equal(result.error, undefined);
});

test("schemas.mint: custom recipient still validated while the toggle is on", () => {
    const bad = schemas.mint.validate({
        editionSize: 1,
        royaltyPercentage: 5,
        useCustomRecipient: true,
        customRecipient: "0x123",
        dataType: "text/plain",
    });
    assert.match(bad.error.message, /valid Ethereum name or address/);

    const good = schemas.mint.validate({
        editionSize: 1,
        royaltyPercentage: 5,
        useCustomRecipient: true,
        customRecipient: "0x12BD0b15D5010De455DCe7944265Fe1D35a84023",
        dataType: "text/plain",
    });
    assert.equal(good.error, undefined);
});

test("schemas.mint: a content type the form cannot offer is rejected", () => {
    // The Ace-based HTML editor was reachable only through this value, and the
    // Create form never offered it. A schema that keeps accepting a dataType no
    // UI can produce is how the unreachable editor survived unnoticed.
    const result = schemas.mint.validate({
        editionSize: 1,
        royaltyPercentage: 5,
        useCustomRecipient: false,
        dataType: "text/html",
    });
    assert.ok(result.error, "text/html must not validate");
});
