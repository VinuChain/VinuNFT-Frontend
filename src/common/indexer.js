import { ethers } from "ethers";
import config from "../config";
import { expandTransfers } from "./history";
import { settlementBreakdown } from "./settlement";

/**
 * A pure fold from contract logs to derived VinuNFT state.
 *
 * This is the indexer CORE only. It owns no network, no storage and no
 * schedule: callers supply logs (queryFilterChunked is the one fetch seam) and
 * own where `serialize` output is kept. There is no shared server-side store,
 * no always-on ingestion and no deployed query API — those need a production
 * host that neither repository names, and nothing here should be read as
 * claiming them.
 *
 * Coverage is carried explicitly on the state rather than assumed: a fold over
 * a bounded scan must never be presented as authoritative global state.
 */
export const INDEX_SCHEMA_VERSION = 1;

const ZERO = ethers.constants.AddressZero;

const NFT_TYPE_BY_ADDRESS = Object.fromEntries(
    Object.entries(config.contractAddresses.v1)
        .filter(([type]) => type !== "marketplace")
        .map(([type, address]) => [address.toLowerCase(), type])
);

/** "text" / "image" for the deployed collections, the raw address otherwise. */
function checksum(address) {
    try {
        return ethers.utils.getAddress(address);
    } catch (e) {
        return address;
    }
}

export function nftTypeOf(address) {
    if (!address) {
        return null;
    }
    const lower = String(address).toLowerCase();
    return NFT_TYPE_BY_ADDRESS[lower] ?? lower;
}

export function tokenKey(nftAddress, tokenId) {
    return `${nftTypeOf(nftAddress)}:${tokenId}`;
}

export function listingKey(nftAddress, tokenId, listingId) {
    return `${tokenKey(nftAddress, tokenId)}:${listingId}`;
}

/**
 * Canonical identity of one indexed record.
 *
 * (block, transactionIndex, logIndex) identifies a log; `subIndex` separates
 * the entries a single TransferBatch expands into, which would otherwise
 * collide and silently drop all but the first.
 */
export function eventId(record) {
    return [
        record.blockNumber,
        record.transactionIndex,
        record.logIndex,
        record.subIndex ?? 0,
    ].join(":");
}

function orderOf(record) {
    return [
        record.blockNumber,
        record.transactionIndex,
        record.logIndex,
        record.subIndex ?? 0,
    ];
}

function compareRecords(a, b) {
    const left = orderOf(a);
    const right = orderOf(b);
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) {
            return left[i] < right[i] ? -1 : 1;
        }
    }
    return 0;
}

/**
 * Decoded log -> JSON-safe indexed records. One record per log, except a
 * TransferBatch, which yields one per (id, value) pair.
 *
 * Transfers are expanded by history.js's `expandTransfers`, not re-parsed here:
 * there is exactly one implementation of that shape in the codebase.
 */
export function normaliseEvent(log) {
    const args = log?.args;
    if (!args) {
        return [];
    }

    const common = {
        event: log.event,
        blockNumber: log.blockNumber,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        transactionHash: log.transactionHash,
        subIndex: 0,
    };
    const stamp = (record) => ({
        ...record,
        // A raw log's `address` is lower-case while an ABI-decoded address arg
        // is checksummed. Normalising here keeps one token record per token
        // however it was sighted, and makes the stored address safe to pass
        // straight back to a contract read.
        nftAddress: checksum(record.nftAddress),
        id: eventId(record),
    });

    switch (log.event) {
        case "TransferSingle":
        case "TransferBatch":
            return expandTransfers(log).map((transfer) =>
                stamp({
                    ...common,
                    subIndex: transfer.subIndex,
                    nftAddress: log.address,
                    tokenId: transfer.id.toString(),
                    operator: transfer.operator,
                    from: transfer.from,
                    to: transfer.to,
                    value: transfer.value.toString(),
                })
            );
        case "TokenListed":
            return [
                stamp({
                    ...common,
                    nftAddress: args._nftAddress,
                    tokenId: args._tokenId.toString(),
                    listingId: args._listingId.toString(),
                    seller: args._seller,
                    // Note the missing underscore: the deployed ABI names this
                    // parameter `amount` while every sibling is `_`-prefixed.
                    amount: args.amount.toString(),
                    paymentToken: args._paymentToken,
                    price: args._price.toString(),
                }),
            ];
        case "TokenDelisted":
            return [
                stamp({
                    ...common,
                    nftAddress: args._nftAddress,
                    tokenId: args._tokenId.toString(),
                    listingId: args._listingId.toString(),
                    seller: args._seller,
                }),
            ];
        case "TokenPurchased":
            return [
                stamp({
                    ...common,
                    nftAddress: args._nftAddress,
                    tokenId: args._tokenId.toString(),
                    listingId: args._listingId.toString(),
                    seller: args._seller,
                    buyer: args._buyer,
                    amount: args._amount.toString(),
                    paymentToken: args._paymentToken,
                    price: args._price.toString(),
                }),
            ];
        default:
            // Ownership, pause and approval logs carry no indexed state.
            return [];
    }
}

export function emptyState() {
    return withDerived({
        version: INDEX_SCHEMA_VERSION,
        events: {},
        // Keyed by eventId / tokenKey and preserved across refolds: both are
        // contract READS, not events, so no fold can reproduce them.
        settlements: {},
        creators: {},
        coverage: {},
        lastIndexedBlock: null,
        lastIndexedAt: null,
    });
}

/**
 * Recompute every derived collection from the event map.
 *
 * ponytail: a full refold per ingest, O(n log n) in the total event count. The
 * whole chain-207 history is 17 records, so this is free today; swap in an
 * incremental fold if the count ever reaches the tens of thousands. Refolding
 * is what makes rewind and idempotent replay correct by construction — the
 * purchase fold DECREMENTS, so replaying a record twice over derived state
 * would double-count it.
 */
function withDerived(state) {
    const listings = {};
    const balances = {};
    const tokens = {};
    const sales = [];

    const records = Object.values(state.events).sort(compareRecords);

    for (const record of records) {
        const key = tokenKey(record.nftAddress, record.tokenId);
        const token = tokens[key] ?? {
            nftType: nftTypeOf(record.nftAddress),
            nftAddress: record.nftAddress,
            tokenId: record.tokenId,
            firstBlock: record.blockNumber,
            lastBlock: record.blockNumber,
            creator: state.creators[key]?.creator ?? null,
            // Null creator means two things — "read, and there is none" and
            // "not read" — and the content policy has to tell them apart.
            creatorKnown: Boolean(state.creators[key]),
            creatorReadAtBlock: state.creators[key]?.blockNumber ?? null,
        };
        token.firstBlock = Math.min(token.firstBlock, record.blockNumber);
        token.lastBlock = Math.max(token.lastBlock, record.blockNumber);
        tokens[key] = token;

        const lKey = listingKey(
            record.nftAddress,
            record.tokenId,
            record.listingId
        );

        switch (record.event) {
            case "TokenListed":
                // `editListing` re-emits TokenListed under the SAME listing id
                // (confirmed on the deployed marketplace: listing text:1:1 was
                // re-emitted five times), so this is a set, not an insert.
                listings[lKey] = {
                    nftType: nftTypeOf(record.nftAddress),
                    nftAddress: record.nftAddress,
                    tokenId: record.tokenId,
                    listingId: record.listingId,
                    seller: record.seller,
                    paymentToken: record.paymentToken,
                    price: record.price,
                    amount: Number(record.amount),
                    updatedAtBlock: record.blockNumber,
                };
                break;
            case "TokenDelisted":
                listings[lKey] = {
                    ...(listings[lKey] ?? {
                        nftType: nftTypeOf(record.nftAddress),
                        nftAddress: record.nftAddress,
                        tokenId: record.tokenId,
                        listingId: record.listingId,
                        seller: record.seller,
                        paymentToken: null,
                        price: "0",
                    }),
                    amount: 0,
                    updatedAtBlock: record.blockNumber,
                };
                break;
            case "TokenPurchased": {
                // A purchase reduces the listed amount without any TokenListed
                // following it. A last-writer-wins fold over TokenListed alone
                // reports 4 for text:1:1 where the chain says 3.
                const previous = listings[lKey];
                if (previous) {
                    listings[lKey] = {
                        ...previous,
                        amount: Math.max(
                            0,
                            previous.amount - Number(record.amount)
                        ),
                        updatedAtBlock: record.blockNumber,
                    };
                }
                sales.push({
                    ...record,
                    nftType: nftTypeOf(record.nftAddress),
                    settlement: state.settlements[record.id] ?? null,
                });
                break;
            }
            default: {
                const owners = balances[key] ?? {};
                const value = Number(record.value);
                if (record.from !== ZERO) {
                    owners[record.from] = (owners[record.from] ?? 0) - value;
                }
                if (record.to !== ZERO) {
                    owners[record.to] = (owners[record.to] ?? 0) + value;
                }
                balances[key] = owners;
            }
        }
    }

    for (const [key, owners] of Object.entries(balances)) {
        balances[key] = Object.fromEntries(
            Object.entries(owners).filter(([, amount]) => amount !== 0)
        );
    }

    return { ...state, listings, balances, tokens, sales };
}

/**
 * Fold `logs` into `state`.
 *
 * `coverage` records which block range each contract was actually scanned over
 * and is the state's honesty about what it does not know. `toBlock` should be
 * the scan head, not the last event block: an index scanned to head with no new
 * events is fresh, and inferring the head from the events would report it stale
 * forever.
 */
export function ingest(state, logs, options = {}) {
    const events = { ...state.events };
    for (const log of logs) {
        for (const record of normaliseEvent(log)) {
            // Set-assignment on the canonical id: replaying the same log, or
            // re-reading a rescanned tail, cannot double-count.
            events[record.id] = record;
        }
    }

    const coverage = { ...state.coverage };
    if (options.address && Number.isInteger(options.toBlock)) {
        const key = String(options.address).toLowerCase();
        const previous = coverage[key];
        coverage[key] = {
            fromBlock: Math.min(
                previous?.fromBlock ?? options.fromBlock ?? options.toBlock,
                options.fromBlock ?? options.toBlock
            ),
            toBlock: Math.max(
                previous?.toBlock ?? options.toBlock,
                options.toBlock
            ),
        };
    }

    const scannedTo = Number.isInteger(options.toBlock)
        ? options.toBlock
        : maxBlock(events);

    return withDerived({
        ...state,
        events,
        coverage,
        lastIndexedBlock:
            scannedTo === null
                ? state.lastIndexedBlock
                : Math.max(state.lastIndexedBlock ?? scannedTo, scannedTo),
        lastIndexedAt: options.at ?? Date.now(),
    });
}

function maxBlock(events) {
    const blocks = Object.values(events).map((r) => r.blockNumber);
    return blocks.length > 0 ? Math.max(...blocks) : null;
}

/**
 * Drop everything from `fromBlock` upward and refold — the reorg response.
 *
 * Pairs with eventScan's REORG_RESCAN_DEPTH: rewind to the same depth, re-fetch
 * that range, ingest it. Because ingest is set-assignment on the canonical id
 * and the derived state is a refold, the overlap is absorbed exactly.
 */
export function rewind(state, fromBlock) {
    const events = Object.fromEntries(
        Object.entries(state.events).filter(
            ([, record]) => record.blockNumber < fromBlock
        )
    );
    // An event id is a POSITION (block, txIndex, logIndex, subIndex), so the
    // replacement chain can put a DIFFERENT sale at the id an orphaned one
    // held. `resolveSettlements` skips any sale that already carries one, so a
    // settlement left behind here would be re-attached to that new sale: wrong
    // price, wrong fee split, wrong receipt reconciliation, and silently.
    const settlements = Object.fromEntries(
        Object.entries(state.settlements).filter(([id]) => id in events)
    );
    // `creators` is an `authorOf` READ against whatever chain is canonical,
    // cached per token and never re-read while the entry stands. A token the
    // rewind leaves with no events at all had its mint orphaned, and the
    // replacement chain can mint that id to someone else — so its entry has to
    // go with it. A token whose older history survives keeps its creator and
    // costs no further call: that read is what the cache exists for.
    const survivingTokens = new Set(
        Object.values(events).map((record) =>
            tokenKey(record.nftAddress, record.tokenId)
        )
    );
    const creators = Object.fromEntries(
        Object.entries(state.creators).filter(([key]) =>
            survivingTokens.has(key)
        )
    );
    const coverage = Object.fromEntries(
        Object.entries(state.coverage).map(([address, range]) => [
            address,
            { ...range, toBlock: Math.min(range.toBlock, fromBlock - 1) },
        ])
    );

    return withDerived({
        ...state,
        events,
        settlements,
        creators,
        coverage,
        lastIndexedBlock:
            state.lastIndexedBlock === null
                ? null
                : Math.min(state.lastIndexedBlock, fromBlock - 1),
    });
}

/**
 * How far behind the chain this state is, or null when it has never ingested.
 *
 * Null rather than zero on purpose: reporting 0 would present an empty index as
 * perfectly fresh, which is the failure mode a freshness signal exists to stop.
 */
export function lag(state, headBlock, now = Date.now()) {
    if (state.lastIndexedBlock === null || !Number.isInteger(headBlock)) {
        return null;
    }
    return {
        blocks: Math.max(0, headBlock - state.lastIndexedBlock),
        seconds:
            state.lastIndexedAt === null
                ? null
                : Math.max(0, (now - state.lastIndexedAt) / 1000),
    };
}

/**
 * A bounded page of indexed events.
 *
 * The cursor is the canonical event id, which is also the sort key, so a page
 * boundary is stable under ingestion: a record arriving at the head cannot
 * shift an earlier page the way a limit/offset window would.
 */
export function queryEvents(state, options = {}) {
    const {
        filter = {},
        limit = 50,
        cursor = null,
        descending = false,
    } = options;

    let rows = Object.values(state.events)
        .filter((record) => matchesFilter(record, filter))
        .sort(compareRecords);

    if (descending) {
        rows.reverse();
    }

    if (cursor) {
        const index = rows.findIndex((record) => record.id === cursor);
        rows = index === -1 ? [] : rows.slice(index + 1);
    }

    const page = rows.slice(0, limit);
    return {
        rows: page,
        nextCursor:
            rows.length > page.length && page.length > 0
                ? page[page.length - 1].id
                : null,
    };
}

function matchesFilter(record, filter) {
    if (filter.event && record.event !== filter.event) {
        return false;
    }
    if (filter.nftType && nftTypeOf(record.nftAddress) !== filter.nftType) {
        return false;
    }
    if (
        filter.tokenId !== undefined &&
        String(record.tokenId) !== String(filter.tokenId)
    ) {
        return false;
    }
    if (filter.address) {
        const wanted = String(filter.address).toLowerCase();
        const seen = [record.from, record.to, record.seller, record.buyer]
            .filter(Boolean)
            .map((a) => String(a).toLowerCase());
        if (!seen.includes(wanted)) {
            return false;
        }
    }
    return true;
}

/**
 * Creator is not derivable from events: both NFT ABIs declare exactly four
 * events (ApprovalForAll, TransferBatch, TransferSingle, URI) and none carries
 * one. It is the `authorOf(id)` READ, taken once per token at a named block and
 * stored with that block, so the value is never mistaken for event-derived.
 */
export async function resolveCreators(state, readers) {
    const creators = { ...state.creators };

    for (const [key, token] of Object.entries(state.tokens)) {
        if (creators[key]) {
            continue;
        }
        try {
            const creator = await readers.authorOf(
                token.nftAddress,
                token.tokenId
            );
            creators[key] = {
                creator: creator ?? null,
                blockNumber: state.lastIndexedBlock,
            };
        } catch (e) {
            // Nothing is stored: an entry here is what makes the pass above
            // skip the token forever, and a throttled read cached as an
            // ordinary null creator is a creator the content policy believes
            // was read. Leaving the key absent keeps it unknown and re-asks on
            // the next load.
            //
            // ponytail: one retried call per unreadable token per load. A token
            // whose authorOf genuinely reverts is re-asked every time; batch it
            // into the multicall this loop already wants if that ever costs.
        }
    }

    return withDerived({ ...state, creators });
}

/**
 * Attach the fee split of one sale.
 *
 * `TokenPurchased` carries no fee legs, so both halves come from outside the
 * event: the ERC-20 Transfer legs of that sale's own receipt, and the split
 * derived from `platformFeePercentage`/`royaltyInfo` read AT THE SALE'S BLOCK
 * (this RPC serves archive state, so the current fee must not be substituted).
 *
 * They are stored together with `legsAgree` because in every sale on chain 207
 * so far the seller, the commission account and the royalty receiver are the
 * same address — legs cannot be attributed by recipient, only derived, and the
 * observed total is the only independent check on that derivation.
 */
export function annotateSale(state, saleEventId, inputs) {
    const {
        platformFeeBps,
        royaltyAmount = null,
        royaltyReceiver = null,
        receiptLegs = [],
    } = inputs;
    const record = state.events[saleEventId];
    if (!record || record.event !== "TokenPurchased") {
        throw new Error(`annotateSale: ${saleEventId} is not an indexed sale`);
    }

    const total = ethers.BigNumber.from(record.price).mul(record.amount);
    const derived = settlementBreakdown({
        total,
        platformFeeBps,
        royaltyAmount,
        royaltyReceiver,
    });

    const observed = receiptLegs
        .map((leg) => ethers.BigNumber.from(leg.value ?? leg))
        .sort(compareBigNumbers);
    const expected = [
        derived.platformFee,
        derived.creatorFee,
        derived.sellerProceeds,
    ]
        .filter((leg) => leg.gt(0))
        .sort(compareBigNumbers);

    const legsAgree =
        observed.length === expected.length &&
        observed.every((leg, i) => leg.eq(expected[i]));

    return withDerived({
        ...state,
        settlements: {
            ...state.settlements,
            [saleEventId]: {
                total: total.toString(),
                platformFee: derived.platformFee.toString(),
                creatorFee: derived.creatorFee.toString(),
                sellerProceeds: derived.sellerProceeds.toString(),
                platformFeeBps: Number(platformFeeBps),
                paymentToken: record.paymentToken,
                observedLegs: observed.map((leg) => leg.toString()),
                legsAgree,
            },
        },
    });
}

function compareBigNumbers(a, b) {
    if (a.eq(b)) return 0;
    return a.lt(b) ? -1 : 1;
}

/**
 * Compare the fold against authoritative contract reads.
 *
 * Returns a list of discrepancies and never throws: a failed read is itself a
 * reported discrepancy, because a reconciliation that dies on the first error
 * reconciles nothing.
 */
export async function reconcile(state, reads) {
    const discrepancies = [];
    const note = (entry) => discrepancies.push(entry);

    const read = async (check, subject, fn) => {
        try {
            return await fn();
        } catch (e) {
            note({ check, subject, error: e.message });
            return undefined;
        }
    };

    for (const [key, listing] of Object.entries(state.listings)) {
        const onChain = await read("listing", key, () =>
            reads.listings(
                listing.nftAddress,
                listing.tokenId,
                listing.listingId
            )
        );
        if (onChain === undefined) continue;

        if (Number(onChain.amount) !== listing.amount) {
            note({
                check: "listing.amount",
                subject: key,
                expected: listing.amount,
                actual: Number(onChain.amount),
            });
        }
        if (
            listing.amount > 0 &&
            String(onChain.price) !== String(listing.price)
        ) {
            note({
                check: "listing.price",
                subject: key,
                expected: String(listing.price),
                actual: String(onChain.price),
            });
        }
    }

    for (const [key, token] of Object.entries(state.tokens)) {
        const count = await read("listingCount", key, () =>
            reads.listingCount(token.nftAddress, token.tokenId)
        );
        if (count !== undefined) {
            const indexed = Object.keys(state.listings).filter((k) =>
                k.startsWith(`${key}:`)
            ).length;
            if (Number(count) !== indexed) {
                note({
                    check: "listingCount",
                    subject: key,
                    expected: indexed,
                    actual: Number(count),
                });
            }
        }

        for (const [address, balance] of Object.entries(
            state.balances[key] ?? {}
        )) {
            const onChain = await read(`balanceOf:${address}`, key, () =>
                reads.balanceOf(token.nftAddress, address, token.tokenId)
            );
            if (onChain !== undefined && Number(onChain) !== balance) {
                note({
                    check: "balanceOf",
                    subject: `${key}:${address}`,
                    expected: balance,
                    actual: Number(onChain),
                });
            }
        }
    }

    return discrepancies;
}

/**
 * JSON checkpoint. Only the inputs are written — events plus the two read-only
 * maps no fold can reproduce — and `deserialize` refolds, so a stored state can
 * never disagree with its own derivation.
 */
export function serialize(state) {
    return JSON.stringify({
        version: INDEX_SCHEMA_VERSION,
        events: state.events,
        settlements: state.settlements,
        creators: state.creators,
        coverage: state.coverage,
        lastIndexedBlock: state.lastIndexedBlock,
        lastIndexedAt: state.lastIndexedAt,
    });
}

export function deserialize(json) {
    let payload;
    try {
        payload = typeof json === "string" ? JSON.parse(json) : json;
    } catch (e) {
        return emptyState();
    }

    // A checkpoint written by a different shape is discarded, not merged:
    // mixing incompatible records is worse than rebuilding from the chain.
    if (!payload || payload.version !== INDEX_SCHEMA_VERSION) {
        return emptyState();
    }

    return withDerived({
        version: INDEX_SCHEMA_VERSION,
        events: payload.events ?? {},
        settlements: payload.settlements ?? {},
        creators: payload.creators ?? {},
        coverage: payload.coverage ?? {},
        lastIndexedBlock: payload.lastIndexedBlock ?? null,
        lastIndexedAt: payload.lastIndexedAt ?? null,
    });
}
