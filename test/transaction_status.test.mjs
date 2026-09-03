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

// === what survives a reload ===

const { nextStoredTransactions, restoreUnresolved, RESTORE_WATCH_MS } =
    mod.default || mod;

test("a finished transaction is not kept for the next reload to replay", () => {
    // Every status carrying a hash used to be stored, and restoration replays
    // every stored entry into a toast. A completed purchase therefore raised
    // its "Transaction mined" toast again on every reload for 24 hours.
    const pending = nextStoredTransactions({}, 4, {
        status: "approved",
        name: "Buy NFTs #1",
        hash: `0x${"33".repeat(32)}`,
    }, NOW);
    assert.deepEqual(Object.keys(pending), ["4"]);

    for (const terminal of ["success", "error"]) {
        assert.deepEqual(
            nextStoredTransactions(pending, 4, {
                status: terminal,
                name: "Buy NFTs #1",
                hash: `0x${"33".repeat(32)}`,
            }, NOW),
            {},
            `a ${terminal} transaction has nothing left to re-resolve`
        );
    }
});

test("a restored transaction is watched until it settles", async () => {
    // The reload lost the original tx.wait(). One getTransactionReceipt on a
    // transaction still in the mempool returns null, and nothing ever asked
    // again: the notification stayed "approved" forever even after it mined.
    const seen = [];
    const provider = {
        getTransactionReceipt: async () => {
            seen.push("receipt");
            return null;
        },
        waitForTransaction: async (hash) => {
            seen.push(hash);
            // Never settles for the first entry, mines for the second.
            if (hash.startsWith("0xaa")) return new Promise(() => {});
            return { status: 1 };
        },
    };
    const entries = [
        { id: 1, status: "approved", hash: `0x${"aa".repeat(32)}` },
        { id: 2, status: "pending", hash: `0x${"bb".repeat(32)}` },
        { id: 3, status: "success", hash: `0x${"cc".repeat(32)}` },
    ];

    const updates = [];
    restoreUnresolved(entries, provider, (id, status) =>
        updates.push([id, status.status])
    );
    // The unsettled first entry must not starve the second: the loop used to
    // await each transaction in turn.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(updates, [[2, "success"]]);
    assert.equal(seen.includes("receipt"), false, "a single receipt query gives up too early");
    assert.equal(seen.length, 2, "a settled transaction is not re-watched");
    assert.ok(RESTORE_WATCH_MS > 0, "the watch is bounded, so a dropped transaction stops polling");
});

test("a sped-up transaction is described by the hash that mined", () => {
    // The mint content function renders its own explorer link from
    // `transaction.hash`, overriding the default one. Handed the superseded
    // original, it sent the user to a hash the chain no longer has.
    const original = { hash: `0x${"11".repeat(32)}`, nonce: 7 };
    const result = classifyTransactionError(
        replaced("repriced", { receipt: { status: 1, blockNumber: 42, logs: [] } }),
        original
    );

    assert.equal(result.transaction.hash, REPLACEMENT);
    assert.equal(result.transaction.nonce, 7, "the rest of the transaction is unchanged");
    assert.equal(original.hash, `0x${"11".repeat(32)}`, "and the original is not mutated");
});

test("an ordinary failure still describes the transaction it was given", () => {
    const original = { hash: `0x${"11".repeat(32)}` };
    const result = classifyTransactionError(
        { code: "UNPREDICTABLE_GAS_LIMIT", message: "reverted" },
        original
    );

    assert.equal(result.transaction, original);
});
