import config from "../config";

/**
 * The VinuChain public RPC rejects `eth_getLogs` when
 * `toBlock - fromBlock` exceeds `config.maxLogBlockRange`
 * ("too wide blocks range, the limit is 100000"). Every historical scan in
 * this app spans millions of blocks, so each one must be split into ranges
 * the node will actually answer.
 */
export const MAX_LOG_BLOCK_RANGE = config.maxLogBlockRange;

/** How many range requests are in flight at once. Matches the concurrency
 *  cap used for marketplace discovery reads against the same single node. */
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

    const ranges = blockRanges(fromBlock, resolvedTo, maxSpan);
    const results = new Array(ranges.length);

    for (let i = 0; i < ranges.length; i += SCAN_CONCURRENCY) {
        const wave = ranges.slice(i, i + SCAN_CONCURRENCY);
        const settled = await Promise.all(
            wave.map(([from, to]) => contract.queryFilter(filter, from, to))
        );
        settled.forEach((events, offset) => {
            results[i + offset] = events;
        });
    }

    return results.flat();
}
