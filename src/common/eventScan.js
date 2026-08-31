import config from "../config";

/**
 * The VinuChain public RPC rejects `eth_getLogs` when
 * `toBlock - fromBlock` exceeds `config.maxLogBlockRange`
 * ("too wide blocks range, the limit is 100000"). Every historical scan in
 * this app spans millions of blocks, so each one must be split into ranges
 * the node will actually answer.
 */
export const MAX_LOG_BLOCK_RANGE = config.maxLogBlockRange;

/** Range requests in flight at once, per contract pass. */
export const SCAN_CONCURRENCY = 8;

/**
 * Split [fromBlock, toBlock] into inclusive sub-ranges of at most `maxSpan`
 * blocks apart. `maxSpan` is a *difference*, not a count: a span of 100000
 * covers 100001 blocks, which is exactly what the node accepts.
 */
export function blockRanges(fromBlock, toBlock, maxSpan = MAX_LOG_BLOCK_RANGE) {
    if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
        throw new TypeError(
            "blockRanges: fromBlock and toBlock must be integers"
        );
    }
    if (!Number.isInteger(maxSpan) || maxSpan < 1) {
        throw new RangeError("blockRanges: maxSpan must be a positive integer");
    }
    if (toBlock < fromBlock) {
        return [];
    }

    const ranges = [];
    for (let start = fromBlock; start <= toBlock; start += maxSpan + 1) {
        ranges.push([start, Math.min(start + maxSpan, toBlock)]);
    }
    return ranges;
}

/**
 * Does `log` satisfy an ethers topic filter? Each filter position is either
 * absent/null (wildcard), a single topic, or an array of alternatives.
 */
export function topicsMatch(logTopics, filterTopics) {
    if (!filterTopics || filterTopics.length === 0) return true;

    return filterTopics.every((want, i) => {
        if (want === null || want === undefined) return true;
        const got = logTopics[i];
        if (got === undefined) return false;
        const candidates = Array.isArray(want) ? want : [want];
        return candidates.some((c) => c.toLowerCase() === got.toLowerCase());
    });
}

/**
 * One decoded, cached pass over every log a contract has emitted.
 *
 * History is built by repeatedly filtering the same events: a token page
 * discovers involved addresses, then re-scans for each of them. Issuing a
 * separate topic-filtered scan per filter multiplied the range requests by the
 * number of filters — measured at 1500 `eth_getLogs` calls and ~20s to render
 * one token's 13 events. Fetching the contract's logs once and filtering in
 * memory makes every additional filter free.
 *
 * Cached per contract address and start block; a later call covering more
 * blocks fetches only the delta.
 */
const logCache = new Map();

export function _resetLogCache() {
    logCache.clear();
}

function allContractEvents(contract, fromBlock, toBlock, maxSpan) {
    const key = `${contract.address.toLowerCase()}:${fromBlock}`;
    const pending = logCache.get(key);

    // The cache holds the in-flight promise, not just the settled result.
    // History fires many filters concurrently; without this every one of them
    // misses simultaneously and starts its own full pass.
    if (pending && pending.toBlock >= toBlock) {
        return pending.promise;
    }

    const entry = {
        toBlock,
        promise: fetchContractEvents(
            contract,
            fromBlock,
            toBlock,
            maxSpan,
            pending
        ),
    };
    logCache.set(key, entry);
    return entry.promise;
}

async function fetchContractEvents(
    contract,
    fromBlock,
    toBlock,
    maxSpan,
    pending
) {
    const address = contract.address;
    const previous = pending ? await pending.promise : [];
    const scanFrom = pending ? pending.toBlock + 1 : fromBlock;
    const ranges = blockRanges(scanFrom, toBlock, maxSpan);
    const fetched = new Array(ranges.length);

    for (let i = 0; i < ranges.length; i += SCAN_CONCURRENCY) {
        const wave = ranges.slice(i, i + SCAN_CONCURRENCY);
        const settled = await Promise.all(
            wave.map(([from, to]) =>
                contract.provider.getLogs({
                    address,
                    fromBlock: from,
                    toBlock: to,
                })
            )
        );
        settled.forEach((logs, offset) => {
            fetched[i + offset] = logs;
        });
    }

    const decoded = [];
    for (const log of fetched.flat()) {
        let parsed;
        try {
            parsed = contract.interface.parseLog(log);
        } catch {
            // An event this ABI does not describe. Skipping keeps an ABI that
            // trails the deployed contract from breaking the whole history.
            continue;
        }
        decoded.push({ ...log, event: parsed.name, args: parsed.args });
    }

    return previous.concat(decoded);
}

/**
 * `contract.queryFilter` that survives the node's block-range limit.
 *
 * Returns events in ascending block order, matching a single unbounded
 * `queryFilter` call. Rejects if any sub-range fails, so a partial history is
 * never silently presented as complete.
 */
export async function queryFilterChunked(
    contract,
    filter,
    fromBlock,
    toBlock = "latest",
    maxSpan = MAX_LOG_BLOCK_RANGE
) {
    const resolvedTo =
        toBlock === "latest" || toBlock === undefined
            ? await contract.provider.getBlockNumber()
            : toBlock;

    const events = await allContractEvents(
        contract,
        fromBlock,
        resolvedTo,
        maxSpan
    );

    return events
        .filter(
            (e) =>
                e.blockNumber >= fromBlock &&
                e.blockNumber <= resolvedTo &&
                topicsMatch(e.topics, filter?.topics)
        )
        .sort(
            (a, b) =>
                a.blockNumber - b.blockNumber ||
                a.transactionIndex - b.transactionIndex ||
                a.logIndex - b.logIndex
        );
}
