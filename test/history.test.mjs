import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import * as _mod from "../src/common/history.js";
import * as _scan from "../src/common/eventScan.js";

// tsx CJS-interop: named exports land on the .default namespace object
const { computeBalances, parseHistory, expandTransfers, getEvents } =
    _mod.default || _mod;
const { _resetLogCache } = _scan.default || _scan;

const ZERO = ethers.constants.AddressZero;
const ALICE = "0x12BD0b15D5010De455DCe7944265Fe1D35a84023";
const BOB = "0x90e839B02e0285bf3dC52FaeB96a967352e4f2f4";
const BN = (n) => ethers.BigNumber.from(n);

// ERC-1155 lets any holder call safeBatchTransferFrom, and both deployed NFT
// ABIs declare TransferBatch — so these logs are reachable on mainnet today.
const batchLog = (overrides = {}) => ({
    event: "TransferBatch",
    blockNumber: 3700000,
    transactionIndex: 0,
    logIndex: 3,
    transactionHash: "0xbatch",
    args: {
        operator: ALICE,
        from: ZERO,
        to: BOB,
        ids: [BN(1), BN(2)],
        values: [BN(3), BN(4)],
        ...overrides,
    },
});

const singleLog = (overrides = {}) => ({
    event: "TransferSingle",
    blockNumber: 3694261,
    transactionIndex: 0,
    logIndex: 0,
    transactionHash: "0xsingle",
    args: {
        operator: ALICE,
        from: ZERO,
        to: ALICE,
        id: BN(1),
        value: BN(100),
        ...overrides,
    },
});

// --- expandTransfers --------------------------------------------------------

test("expandTransfers: a TransferSingle expands to itself, one record", () => {
    const [only, ...rest] = expandTransfers(singleLog());
    assert.equal(rest.length, 0);
    assert.equal(only.id.toString(), "1");
    assert.equal(only.value.toString(), "100");
    assert.equal(only.from, ZERO);
    assert.equal(only.to, ALICE);
    assert.equal(only.subIndex, 0);
});

test("expandTransfers: a TransferBatch expands to one record per (id, value)", () => {
    const records = expandTransfers(batchLog());
    assert.equal(records.length, 2);
    assert.deepEqual(
        records.map((r) => r.id.toString()),
        ["1", "2"]
    );
    assert.deepEqual(
        records.map((r) => r.value.toString()),
        ["3", "4"]
    );
    // Distinct sub-indices: a collision here silently drops half a batch when
    // the records are keyed for dedup.
    assert.deepEqual(
        records.map((r) => r.subIndex),
        [0, 1]
    );
});

test("expandTransfers: a non-transfer event expands to nothing", () => {
    assert.deepEqual(expandTransfers({ event: "TokenListed", args: {} }), []);
});

// --- parse layer ------------------------------------------------------------

test("parseHistory: a batch mint produces one row per id, not an unknown event", () => {
    const rows = parseHistory([batchLog()]);
    assert.equal(rows.length, 2, "both batch entries must appear in history");
    assert.deepEqual(
        rows.map((r) => r.type),
        ["mint", "mint"]
    );
    assert.deepEqual(
        rows.map((r) => r.id),
        [1, 2]
    );
    assert.deepEqual(
        rows.map((r) => r.amount),
        [3, 4]
    );
});

test("parseHistory: a batch to the zero address is a burn", () => {
    const rows = parseHistory([batchLog({ from: ALICE, to: ZERO })]);
    assert.deepEqual(
        rows.map((r) => r.type),
        ["burn", "burn"]
    );
});

test("parseHistory: TransferSingle rows are unchanged", () => {
    const rows = parseHistory([singleLog()]);
    assert.deepEqual(rows, [
        {
            id: 1,
            type: "mint",
            from: ZERO,
            to: ALICE,
            amount: 100,
            operator: ALICE,
            transactionHash: "0xsingle",
            blockNumber: 3694261,
            nftType: undefined,
        },
    ]);
});

// --- balance layer ----------------------------------------------------------

test("computeBalances: a batch credits the recipient every id it carries", () => {
    const balances = computeBalances([batchLog()]);
    assert.deepEqual(balances, { [BOB]: 7 });
});

test("computeBalances: a batch debits the sender", () => {
    const balances = computeBalances([
        singleLog({ from: ZERO, to: ALICE, id: BN(1), value: BN(10) }),
        batchLog({ from: ALICE, to: BOB, ids: [BN(1)], values: [BN(4)] }),
    ]);
    assert.deepEqual(balances, { [ALICE]: 6, [BOB]: 4 });
});

// --- fetch layer ------------------------------------------------------------

/**
 * Minimal stand-in for an ethers Contract whose only log is a TransferBatch.
 * `filters.*` return the topic shape queryFilterChunked matches on, so a
 * missing TransferBatch filter means the log is never requested at all.
 */
const BATCH_TOPIC = ethers.utils.id(
    "TransferBatch(address,address,address,uint256[],uint256[])"
);
const SINGLE_TOPIC = ethers.utils.id(
    "TransferSingle(address,address,address,uint256,uint256)"
);

function fakeNftContract() {
    const rawBatch = {
        blockNumber: 3700000,
        transactionIndex: 0,
        logIndex: 3,
        transactionHash: "0xbatch",
        topics: [
            BATCH_TOPIC,
            ethers.utils.hexZeroPad(ALICE, 32),
            ethers.utils.hexZeroPad(ZERO, 32),
            ethers.utils.hexZeroPad(BOB, 32),
        ],
    };
    return {
        address: "0x8974168eC4c942C6D34161e994A759DC3F19b5a8",
        filters: {
            TransferSingle: (...topics) => ({
                topics: [SINGLE_TOPIC, ...normalise(topics)],
            }),
            TransferBatch: (...topics) => ({
                topics: [BATCH_TOPIC, ...normalise(topics)],
            }),
        },
        interface: {
            parseLog: (l) => {
                if (l.topics[0] !== BATCH_TOPIC) throw new Error("unknown");
                return {
                    name: "TransferBatch",
                    args: {
                        operator: ALICE,
                        from: ZERO,
                        to: BOB,
                        ids: [BN(1), BN(2)],
                        values: [BN(3), BN(4)],
                    },
                };
            },
        },
        provider: {
            getBlockNumber: async () => 3700000,
            getLogs: async ({ fromBlock, toBlock }) =>
                rawBatch.blockNumber >= fromBlock &&
                rawBatch.blockNumber <= toBlock
                    ? [rawBatch]
                    : [],
        },
    };
}

const normalise = (topics) =>
    topics.map((t) =>
        t === null || t === undefined ? null : ethers.utils.hexZeroPad(t, 32)
    );

function fakeMarketplace() {
    return {
        address: "0xcA396A95E0EB8B6804e25F9db131780a60564047",
        filters: {
            TokenListed: () => ({ topics: ["0x" + "1".repeat(64)] }),
            TokenDelisted: () => ({ topics: ["0x" + "2".repeat(64)] }),
            TokenPurchased: () => ({ topics: ["0x" + "3".repeat(64)] }),
        },
        interface: { parseLog: () => { throw new Error("unknown"); } },
        provider: {
            getBlockNumber: async () => 3700000,
            getLogs: async () => [],
        },
    };
}

test("getEvents: a batch transfer is fetched at all", async () => {
    _resetLogCache();
    const events = await getEvents(
        null,
        fakeNftContract(),
        fakeMarketplace(),
        null,
        3699900,
        3699900
    );
    assert.equal(
        events.length,
        1,
        "a TransferBatch log must be requested and kept, not filtered away"
    );
    assert.equal(events[0].event, "TransferBatch");
});
