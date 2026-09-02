import config from "../config";

/**
 * The VinuChain public RPC rejects `eth_getLogs` when
 * `toBlock - fromBlock` exceeds `config.maxLogBlockRange`
 * ("too wide blocks range, the limit is 100000"). Every historical scan in
 * this app spans millions of blocks, so each one must be split into ranges
 * the node will actually answer.
 *
 * The 100000 is conditional on the request carrying a filter. A request with
 * no `address` and no `topics` is capped at 100 instead — the same on chain
 * 207 and chain 206, so this is not a per-network value. `fetchContractEvents`
 * below always passes `address`, and must keep doing so: without it the node
 * would answer only 100 blocks at a time, making a backfill 1000x more
 * requests. test/eventScan.test.mjs enforces that with a fake that applies
 * both limits exactly as the node does.
 */
export const MAX_LOG_BLOCK_RANGE = config.maxLogBlockRange;

/** The cap for a request that filters on neither address nor topics. */
export const MAX_UNFILTERED_LOG_BLOCK_RANGE = config.maxUnfilteredLogBlockRange;

/** Range requests in flight at once, per contract pass. */
export const SCAN_CONCURRENCY = 8;

/**
 * How far back a delta scan re-reads blocks it has already cached.
 *
 * A later call reuses the cached events and resumes after them, so a log from
 * a block the chain later orphaned would be served to history, discovery and
 * profiles for the rest of the session with nothing to displace it. Re-reading
 * the tail lets the canonical chain's logs replace it.
 *
 * ponytail: a reorg deeper than this window is not detected. The cheap
 * alternative — scanning only up to the `finalized`/`safe` block tag — is
 * unavailable because this RPC rejects both tags.
 */
export const REORG_RESCAN_DEPTH = 128;

/**
 * Attempts per sub-range before the whole pass fails. A marketplace scan is
 * ~125 ranges against a public RPC, so one throttled range would otherwise
 * discard 124 completed ones. The reject-on-final-failure contract is
 * unchanged: a partial history is still never presented as complete.
 */
export const RANGE_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;

async function getLogsWithRetry(provider, params) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await provider.getLogs(params);
        } catch (error) {
            if (attempt >= RANGE_ATTEMPTS) {
                throw error;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, RETRY_BACKOFF_MS * attempt)
            );
        }
    }
}

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

    const entry = { toBlock };
    entry.promise = fetchContractEvents(
        contract,
        fromBlock,
        toBlock,
        maxSpan,
        pending
    ).catch((error) => {
        // Never leave a rejected promise cached. One throttled sub-range out of
        // ~250 would otherwise be served to every later caller, bricking
        // history until reload instead of failing a single attempt.
        if (logCache.get(key) === entry) {
            logCache.delete(key);
        }
        throw error;
    });
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
    const scanFrom = pending
        ? Math.max(fromBlock, pending.toBlock + 1 - REORG_RESCAN_DEPTH)
        : fromBlock;
    // Everything at or above scanFrom is about to be fetched again; keeping the
    // cached copies too would both resurrect orphaned logs and double-count the
    // rescanned ones.
    const kept = previous.filter((e) => e.blockNumber < scanFrom);
    const ranges = blockRanges(scanFrom, toBlock, maxSpan);
    const fetched = new Array(ranges.length);

    for (let i = 0; i < ranges.length; i += SCAN_CONCURRENCY) {
        const wave = ranges.slice(i, i + SCAN_CONCURRENCY);
        const settled = await Promise.all(
            wave.map(([from, to]) =>
                getLogsWithRetry(contract.provider, {
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
        // Defensive: eth_getLogs on canonical blocks never sets this — a
        // reverted log is simply absent from the result. It is set by
        // eth_getFilterChanges, which this app does not use today.
        if (log.removed) {
            continue;
        }

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

    return kept.concat(decoded);
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
