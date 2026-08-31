import { test } from "node:test";
import assert from "node:assert/strict";
import * as _mod from "../src/common/eventScan.js";

// tsx CJS-interop: named exports land on the .default namespace object
const { blockRanges, queryFilterChunked, MAX_LOG_BLOCK_RANGE, SCAN_CONCURRENCY } =
    _mod.default || _mod;

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

// --- queryFilterChunked ----------------------------------------------------

/** Stands in for an ethers Contract, rejecting over-wide ranges like the node. */
function fakeContract(head, eventsByBlock = {}) {
    const asked = [];
    return {
        asked,
        provider: { getBlockNumber: async () => head },
        queryFilter: async (_filter, from, to) => {
            asked.push([from, to]);
            if (to - from > NODE_LIMIT) {
                throw new Error("too wide blocks range, the limit is 100000");
            }
            return Object.entries(eventsByBlock)
                .filter(([b]) => Number(b) >= from && Number(b) <= to)
                .map(([b, v]) => ({ blockNumber: Number(b), tag: v }));
        },
    };
}

test("queryFilterChunked: never asks the node for an over-wide range", async () => {
    const c = fakeContract(HEAD_AT_AUDIT);
    await queryFilterChunked(c, {}, MARKETPLACE_FIRST_BLOCK, "latest");
    assert.ok(c.asked.length > 1);
    for (const [from, to] of c.asked) {
        assert.ok(to - from <= NODE_LIMIT, `asked for ${from}..${to}`);
    }
});

test("queryFilterChunked: resolves 'latest' and covers up to the head block", async () => {
    const c = fakeContract(250000);
    await queryFilterChunked(c, {}, 0, "latest");
    assert.equal(Math.max(...c.asked.map(([, to]) => to)), 250000);
});

test("queryFilterChunked: returns every event in ascending block order", async () => {
    const c = fakeContract(300000, { 10: "a", 150000: "b", 275000: "c" });
    const events = await queryFilterChunked(c, {}, 0, "latest");
    assert.deepEqual(events.map((e) => e.tag), ["a", "b", "c"]);
    assert.deepEqual(events.map((e) => e.blockNumber), [10, 150000, 275000]);
});

test("queryFilterChunked: a failing sub-range rejects rather than returning partial history", async () => {
    const c = fakeContract(500000, { 10: "a" });
    const realQuery = c.queryFilter;
    c.queryFilter = async (f, from, to) => {
        if (from > 200000) throw new Error("node unavailable");
        return realQuery(f, from, to);
    };
    await assert.rejects(
        () => queryFilterChunked(c, {}, 0, "latest"),
        /node unavailable/,
        "partial history must never be presented as complete"
    );
});

test("queryFilterChunked: honours an explicit numeric toBlock", async () => {
    const c = fakeContract(9999999, { 10: "a", 500000: "toolate" });
    const events = await queryFilterChunked(c, {}, 0, 100000);
    assert.deepEqual(events.map((e) => e.tag), ["a"]);
    assert.deepEqual(c.asked, [[0, 100000]]);
});

test("scan concurrency is bounded", () => {
    assert.ok(SCAN_CONCURRENCY >= 1 && SCAN_CONCURRENCY <= 16);
});
