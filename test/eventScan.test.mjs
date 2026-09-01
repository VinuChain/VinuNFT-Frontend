import { test } from "node:test";
import assert from "node:assert/strict";
import * as _mod from "../src/common/eventScan.js";

// tsx CJS-interop: named exports land on the .default namespace object
const {
    blockRanges,
    queryFilterChunked,
    topicsMatch,
    _resetLogCache,
    MAX_LOG_BLOCK_RANGE,
    SCAN_CONCURRENCY,
} = _mod.default || _mod;

// Verified against VinuChain: the node rejects eth_getLogs when
// toBlock - fromBlock > 100000 ("too wide blocks range, the limit is 100000").
const NODE_LIMIT = 100000;

// Real deployment truth, confirmed via each contract's creation transaction.
const MARKETPLACE_FIRST_BLOCK = 2232125;
const HEAD_AT_AUDIT = 14719796;

test("MAX_LOG_BLOCK_RANGE matches the limit the node actually enforces", () => {
    assert.equal(MAX_LOG_BLOCK_RANGE, NODE_LIMIT);
});

test("blockRanges: no range exceeds the node limit across the real scan span", () => {
    const ranges = blockRanges(MARKETPLACE_FIRST_BLOCK, HEAD_AT_AUDIT);
    assert.ok(ranges.length > 1, "a 12.5M block span must be split");
    for (const [from, to] of ranges) {
        assert.ok(
            to - from <= NODE_LIMIT,
            `range ${from}..${to} spans ${to - from}, over the node limit`
        );
    }
});

test("blockRanges: covers every block exactly once, contiguously", () => {
    const ranges = blockRanges(1000, 350000);
    assert.equal(ranges[0][0], 1000);
    assert.equal(ranges[ranges.length - 1][1], 350000);
    for (let i = 1; i < ranges.length; i++) {
        assert.equal(
            ranges[i][0],
            ranges[i - 1][1] + 1,
            "ranges must be contiguous with no gap and no overlap"
        );
    }
});

test("blockRanges: a span of exactly the limit stays one range", () => {
    // The node accepts toBlock - fromBlock === 100000 (an inclusive 100001 blocks).
    const ranges = blockRanges(0, NODE_LIMIT);
    assert.deepEqual(ranges, [[0, NODE_LIMIT]]);
});

test("blockRanges: one block over the limit splits into two", () => {
    const ranges = blockRanges(0, NODE_LIMIT + 1);
    assert.deepEqual(ranges, [[0, NODE_LIMIT], [NODE_LIMIT + 1, NODE_LIMIT + 1]]);
});

test("blockRanges: single block, and empty when toBlock precedes fromBlock", () => {
    assert.deepEqual(blockRanges(500, 500), [[500, 500]]);
    assert.deepEqual(blockRanges(500, 499), []);
});

test("blockRanges: rejects non-integer and non-positive inputs", () => {
    assert.throws(() => blockRanges(1.5, 10), TypeError);
    assert.throws(() => blockRanges("1", 10), TypeError);
    assert.throws(() => blockRanges(0, 10, 0), RangeError);
});

// --- topic matching ---------------------------------------------------------

test("topicsMatch: absent or empty filter matches everything", () => {
    assert.equal(topicsMatch(["0xaa"], undefined), true);
    assert.equal(topicsMatch(["0xaa"], []), true);
});

test("topicsMatch: null positions are wildcards, others must match", () => {
    const log = ["0xaa", "0xbb", "0xcc"];
    assert.equal(topicsMatch(log, ["0xaa", null, "0xcc"]), true);
    assert.equal(topicsMatch(log, ["0xaa", "0xzz"]), false);
    assert.equal(topicsMatch(log, [null, null, null]), true);
});

test("topicsMatch: is case insensitive and supports alternatives", () => {
    assert.equal(topicsMatch(["0xAA"], ["0xaa"]), true);
    assert.equal(topicsMatch(["0xaa"], [["0xbb", "0xaa"]]), true);
    assert.equal(topicsMatch(["0xaa"], [["0xbb", "0xcc"]]), false);
});

test("topicsMatch: a filter deeper than the log's topics does not match", () => {
    assert.equal(topicsMatch(["0xaa"], ["0xaa", "0xbb"]), false);
});

// --- queryFilterChunked -----------------------------------------------------

const SIG_A = "0x" + "a".repeat(64);
const SIG_B = "0x" + "b".repeat(64);

/** Stands in for an ethers Contract, rejecting over-wide ranges like the node. */
function fakeContract(head, logs = [], address = "0xCafe") {
    const asked = [];
    return {
        address,
        asked,
        interface: {
            parseLog: (log) => {
                if (log.topics[0] === SIG_A) return { name: "Alpha", args: ["a"] };
                if (log.topics[0] === SIG_B) return { name: "Beta", args: ["b"] };
                throw new Error("unknown event");
            },
        },
        provider: {
            getBlockNumber: async () => head,
            getLogs: async ({ fromBlock, toBlock }) => {
                asked.push([fromBlock, toBlock]);
                if (toBlock - fromBlock > NODE_LIMIT) {
                    throw new Error("too wide blocks range, the limit is 100000");
                }
                return logs.filter(
                    (l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock
                );
            },
        },
    };
}

const log = (blockNumber, topic, logIndex = 0) => ({
    blockNumber,
    transactionIndex: 0,
    logIndex,
    transactionHash: `0x${blockNumber}`,
    topics: [topic],
});

test("queryFilterChunked: never asks the node for an over-wide range", async () => {
    _resetLogCache();
    const c = fakeContract(HEAD_AT_AUDIT);
    await queryFilterChunked(c, { topics: [SIG_A] }, MARKETPLACE_FIRST_BLOCK, "latest");
    assert.ok(c.asked.length > 1);
    for (const [from, to] of c.asked) {
        assert.ok(to - from <= NODE_LIMIT, `asked for ${from}..${to}`);
    }
});

test("queryFilterChunked: resolves 'latest' and covers up to the head block", async () => {
    _resetLogCache();
    const c = fakeContract(250000);
    await queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest");
    assert.equal(Math.max(...c.asked.map(([, to]) => to)), 250000);
});

test("queryFilterChunked: returns matching events in ascending block order", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(275000, SIG_A), log(10, SIG_A), log(150000, SIG_B)]);
    const events = await queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest");
    assert.deepEqual(events.map((e) => e.blockNumber), [10, 275000]);
    assert.deepEqual(events.map((e) => e.event), ["Alpha", "Alpha"]);
});

test("queryFilterChunked: a second filter reuses the cached pass, costing no requests", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(10, SIG_A), log(20, SIG_B)]);
    await queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest");
    const afterFirst = c.asked.length;
    const beta = await queryFilterChunked(c, { topics: [SIG_B] }, 0, "latest");
    assert.equal(c.asked.length, afterFirst, "second filter must not re-scan");
    assert.deepEqual(beta.map((e) => e.event), ["Beta"]);
});

test("queryFilterChunked: concurrent filters share one pass", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(10, SIG_A), log(20, SIG_B)]);
    // History fires its filters together; without in-flight caching each one
    // starts its own full pass, which is what cost 1500 requests per page.
    await Promise.all([
        queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest"),
        queryFilterChunked(c, { topics: [SIG_B] }, 0, "latest"),
        queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest"),
    ]);
    assert.equal(c.asked.length, blockRanges(0, 300000).length);
});

test("queryFilterChunked: an undecodable log does not break the scan", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(10, SIG_A), log(15, "0x" + "f".repeat(64))]);
    const events = await queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest");
    assert.deepEqual(events.map((e) => e.blockNumber), [10]);
});

test("queryFilterChunked: a failing sub-range rejects rather than returning partial history", async () => {
    _resetLogCache();
    const c = fakeContract(500000, [log(10, SIG_A)]);
    const real = c.provider.getLogs;
    c.provider.getLogs = async (args) => {
        if (args.fromBlock > 200000) throw new Error("node unavailable");
        return real(args);
    };
    await assert.rejects(
        () => queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest"),
        /node unavailable/,
        "partial history must never be presented as complete"
    );
});

test("queryFilterChunked: honours an explicit numeric toBlock", async () => {
    _resetLogCache();
    const c = fakeContract(9999999, [log(10, SIG_A), log(500000, SIG_A)]);
    const events = await queryFilterChunked(c, { topics: [SIG_A] }, 0, 100000);
    assert.deepEqual(events.map((e) => e.blockNumber), [10]);
    assert.deepEqual(c.asked, [[0, 100000]]);
});

test("scan concurrency is bounded", () => {
    assert.ok(SCAN_CONCURRENCY >= 1 && SCAN_CONCURRENCY <= 16);
});

test("queryFilterChunked: a failed pass is not cached, so a retry can succeed", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(10, SIG_A), log(250000, SIG_A)]);
    const real = c.provider.getLogs;
    let failing = true;
    c.provider.getLogs = async (args) => {
        if (failing && args.fromBlock > 200000) {
            throw new Error("throttled");
        }
        return real(args);
    };

    await assert.rejects(
        () => queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest"),
        /throttled/
    );

    // A transient node failure must not poison the cache for the page's life.
    failing = false;
    const events = await queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest");
    assert.deepEqual(events.map((e) => e.blockNumber), [10, 250000]);
});

test("queryFilterChunked: a failed wider pass does not poison an earlier range", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(10, SIG_A)]);
    const real = c.provider.getLogs;
    let failing = true;
    c.provider.getLogs = async (args) => {
        if (failing && args.fromBlock > 100000) throw new Error("throttled");
        return real(args);
    };
    await assert.rejects(() => queryFilterChunked(c, { topics: [SIG_A] }, 0, 300000), /throttled/);
    failing = false;
    const events = await queryFilterChunked(c, { topics: [SIG_A] }, 0, 100000);
    assert.deepEqual(events.map((e) => e.blockNumber), [10]);
});

// --- reorg safety, retry and removed-log handling ---------------------------

test("queryFilterChunked: a delta scan re-reads the recent tail, so an orphaned log is dropped", async () => {
    _resetLogCache();
    // `logs` is the contract's live log set; mutating it simulates the node
    // answering differently after a reorg replaced the tip.
    const logs = [log(299999, SIG_A, 0)];
    const c = fakeContract(300000, logs);
    const first = await queryFilterChunked(c, { topics: [SIG_A] }, 0, 300000);
    assert.deepEqual(first.map((e) => e.transactionHash), ["0x299999"]);

    // Reorg: the block at 299999 is rebuilt and carries a different log.
    logs.length = 0;
    logs.push({ ...log(299999, SIG_A, 0), transactionHash: "0xreplacement" });

    // The head MUST advance past the cached toBlock, or allContractEvents
    // early-returns the cached promise and this passes for the wrong reason.
    const second = await queryFilterChunked(c, { topics: [SIG_A] }, 0, 400000);
    assert.deepEqual(
        second.map((e) => e.transactionHash),
        ["0xreplacement"],
        "an orphaned log must not survive the delta concat"
    );
});

test("queryFilterChunked: the rescan window never re-reads below fromBlock", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(250000, SIG_A)]);
    await queryFilterChunked(c, { topics: [SIG_A] }, 250000, 300000);
    await queryFilterChunked(c, { topics: [SIG_A] }, 250000, 400000);
    for (const [from] of c.asked) {
        assert.ok(from >= 250000, `rescan asked for ${from}, below fromBlock`);
    }
});

test("queryFilterChunked: rescanning does not duplicate an unchanged log", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(299999, SIG_A)]);
    await queryFilterChunked(c, { topics: [SIG_A] }, 0, 300000);
    const second = await queryFilterChunked(c, { topics: [SIG_A] }, 0, 400000);
    assert.equal(second.length, 1, "the rescanned tail must replace, not append");
});

test("queryFilterChunked: a transiently failing sub-range is retried, not fatal", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(10, SIG_A), log(250000, SIG_A)]);
    const real = c.provider.getLogs;
    let attempts = 0;
    c.provider.getLogs = async (args) => {
        if (args.fromBlock === 200002) {
            attempts++;
            if (attempts === 1) throw new Error("throttled");
        }
        return real(args);
    };

    const events = await queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest");
    assert.deepEqual(events.map((e) => e.blockNumber), [10, 250000]);
    assert.equal(attempts, 2, "the throttled range must be asked for again");
});

test("queryFilterChunked: a permanently failing sub-range still rejects", async () => {
    _resetLogCache();
    const c = fakeContract(300000, [log(10, SIG_A)]);
    const real = c.provider.getLogs;
    c.provider.getLogs = async (args) => {
        if (args.fromBlock === 200002) throw new Error("node unavailable");
        return real(args);
    };
    // Retries must not let an outage be served as a complete history.
    await assert.rejects(
        () => queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest"),
        /node unavailable/
    );
});

test("queryFilterChunked: a log flagged removed is skipped (defensive only)", async () => {
    _resetLogCache();
    // DEFENSIVE: eth_getLogs on canonical blocks reports removed:false for
    // every log (checked against all 11 live marketplace logs) — a reverted log
    // is simply absent. removed:true comes from eth_getFilterChanges, which
    // this app never calls. This is a guard, not a shipped-defect regression.
    const c = fakeContract(300000, [
        { ...log(10, SIG_A), removed: true },
        log(20, SIG_A),
    ]);
    const events = await queryFilterChunked(c, { topics: [SIG_A] }, 0, "latest");
    assert.deepEqual(events.map((e) => e.blockNumber), [20]);
});
