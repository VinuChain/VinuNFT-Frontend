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
