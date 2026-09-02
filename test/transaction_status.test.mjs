import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { chainReceipt } from "./helpers/browserHarness.mjs";

const mod = await import("../src/common/transaction_status.js");
const { classifyTransactionError } = mod.default || mod;

const REPLACEMENT = `0x${"22".repeat(32)}`;

const replaced = (reason, extra = {}) => ({
    code: "TRANSACTION_REPLACED",
    reason,
    replacement: { hash: REPLACEMENT },
    ...extra,
});

test("a repriced transaction succeeded, on the replacement hash", () => {
    const receipt = { status: 1, blockNumber: 42, logs: [] };
    const result = classifyTransactionError(replaced("repriced", { receipt }));

    assert.equal(result.status, "success");
    assert.equal(result.hash, REPLACEMENT);
    assert.equal(result.receipt.blockNumber, 42);
    // A provider receipt has no parsed events; minting.js reads them unguarded.
    assert.deepEqual(result.receipt.events, []);
});

test("a repriced transaction keeps events it already carries", () => {
    const events = [{ event: "TransferSingle" }];
    const result = classifyTransactionError(
        replaced("repriced", { receipt: { blockNumber: 42, events } })
    );

    assert.deepEqual(result.receipt.events, events);
});

test("a repriced mint's raw receipt still identifies the minted token", () => {
    // A repriced receipt comes from the provider, so its logs are raw. This one
    // is the harness's realistic TransferSingle — same encoding a wallet
    // returns — and the assertions below are the predicate mint.js and
    // minting.js actually run on `receipt.events`.
    const receipt = chainReceipt({
        transferSingle: { nft: "text", id: 7, amount: 1 },
    });
    const result = classifyTransactionError(replaced("repriced", { receipt }));

    const minted = result.receipt.events.filter(
        (event) =>
            event.event === "TransferSingle" &&
            event.args.from === ethers.constants.AddressZero
    );
    assert.equal(
        minted.length,
        1,
        "a sped-up mint that mined must still name its token"
    );
    assert.equal(minted[0].args[3].toString(), "7");
});

test("a log no shipped ABI describes survives decoding as a raw entry", () => {
    // ethers' own wait() leaves unparseable logs in place rather than dropping
    // them, and a receipt that silently loses logs is worse than one with none.
    const receipt = chainReceipt({ transferSingle: { nft: "text", id: 7 } });
    const stranger = { ...receipt.logs[0], address: `0x${"11".repeat(20)}` };
    const result = classifyTransactionError(
        replaced("repriced", { receipt: { ...receipt, logs: [stranger] } })
    );

    assert.equal(result.receipt.events.length, 1);
    assert.equal(result.receipt.events[0].event, undefined);
    assert.equal(result.receipt.events[0].address, stranger.address);
});

test("a cancelled transaction is an error naming the replacement", () => {
    const result = classifyTransactionError(replaced("cancelled"));

    assert.equal(result.status, "error");
    assert.equal(result.hash, REPLACEMENT);
    assert.match(result.errorMessage, /cancelled/i);
});

test("a replaced transaction is an error naming the replacement", () => {
    const result = classifyTransactionError(replaced("replaced"));

    assert.equal(result.status, "error");
    assert.equal(result.hash, REPLACEMENT);
    assert.match(result.errorMessage, /replaced/i);
});

test("anything else keeps the existing formatted error and no hash", () => {
    const result = classifyTransactionError({
        code: "UNPREDICTABLE_GAS_LIMIT",
        message: "execution reverted: not enough tokens",
    });

    assert.equal(result.status, "error");
    assert.equal(result.hash, undefined);
    assert.ok(result.errorMessage.length > 0);
});

const { pruneTransactions, statusFromReceipt, TRANSACTION_MAX_AGE_MS } =
    mod.default || mod;

const NOW = 1_700_000_000_000;
const stored = (updatedAt) => ({
    id: 0,
    name: "Buy NFTs #1",
    status: "approved",
    hash: `0x${"33".repeat(32)}`,
    updatedAt,
});

test("prune keeps a transaction from within the last day", () => {
    const kept = { a: stored(NOW - TRANSACTION_MAX_AGE_MS + 1000) };

    assert.deepEqual(pruneTransactions(kept, NOW), kept);
});

test("prune drops a transaction older than a day, so the key cannot grow forever", () => {
    const result = pruneTransactions(
        { old: stored(NOW - TRANSACTION_MAX_AGE_MS - 1), new: stored(NOW) },
        NOW
    );

    assert.deepEqual(Object.keys(result), ["new"]);
});

test("prune survives absent and malformed storage", () => {
    assert.deepEqual(pruneTransactions(null, NOW), {});
    assert.deepEqual(pruneTransactions({ a: null, b: {} }, NOW), {});
});

test("a mined receipt resolves a restored transaction to success", () => {
    const result = statusFromReceipt(stored(NOW), { status: 1 });

    assert.equal(result.status, "success");
    assert.equal(result.hash, stored(NOW).hash);
});

test("a reverted receipt resolves to error with a message the toast can render", () => {
    const result = statusFromReceipt(stored(NOW), { status: 0 });

    assert.equal(result.status, "error");
    // TransactionNotifications truncates errorMessage unguarded.
    assert.equal(typeof result.errorMessage, "string");
});

test("no receipt means no news, so the transaction stays pending", () => {
    assert.equal(statusFromReceipt(stored(NOW), null), null);
});
