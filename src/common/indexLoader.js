import { ethers } from "ethers";
import config from "../config";
import { v1 } from "./abi";
import { queryFilterChunked, REORG_RESCAN_DEPTH } from "./eventScan";
import {
    annotateSale,
    emptyState,
    ingest,
    nftTypeOf,
    resolveCreators,
    rewind,
    tokenKey,
} from "./indexer";
import { deriveTokenType } from "./nftInfo";
import { tokenAddressToId } from "./user";
import { formatTokenAmount } from "./utils";

/**
 * The seam between the chain and the pure fold in `indexer.js`.
 *
 * `indexer.js` owns no network and `eventScan.js` owns no state; this module is
 * the only place the two meet. It scans all three deployed contracts from their
 * verified first blocks, folds the result, and hands consumers derived state
 * plus the block it is current to — so a page can say how fresh its view is
 * instead of implying it is live.
 *
 * The index lives for the lifetime of the tab. There is no shared server-side
 * store and no ingestion independent of a page load: both need a production
 * host neither repository names, and nothing here should be read as claiming
 * them.
 */
const SCANNED = ["marketplace", "text", "image"];

/** Collections this app can render. The marketplace accepts any `_nftAddress`. */
const RENDERABLE = ["text", "image"];

const ERC20_TRANSFER = new ethers.utils.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

let indexState = null;
let inflight = null;
// Content type per token. Not folded state: it comes from `textURI`, a read,
// and lives here rather than in the indexer because only the listing card
// consumes it.
let formatCache = {};

export function _resetIndex() {
    indexState = null;
    inflight = null;
    formatCache = {};
}

/**
 * The index, current to the head block it reports.
 *
 * Concurrent callers share one pass — the marketplace and profile routes both
 * want the same index, and two simultaneous cold scans would double the ~375
 * range requests for identical data. A later call re-reads only the delta:
 * eventScan caches each contract's decoded pass, and `ingest` is set-assignment
 * on the canonical event id, so re-folding what is already indexed is free and
 * cannot double-count.
 */
export async function loadIndex(readProvider) {
    if (!inflight) {
        inflight = refresh(readProvider).finally(() => {
            inflight = null;
        });
    }
    return inflight;
}

async function refresh(readProvider) {
    const headBlock = await readProvider.getBlockNumber();

    // All three scans resolve or none is ingested. queryFilterChunked already
    // rejects rather than returning a partial range set; ingesting whichever
    // contracts happened to succeed would put that honesty straight back into
    // a subset the UI cannot tell from the whole marketplace.
    const scans = await Promise.all(
        SCANNED.map(async (name) => {
            const address = config.contractAddresses.v1[name];
            const fromBlock = config.firstBlocks.v1[name];
            const contract = new ethers.Contract(
                address,
                v1[name],
                readProvider
            );
            return {
                address,
                fromBlock,
                // `rescanTail`: this fold is rewound and rebuilt from the
                // tail below, which is only an improvement if the tail that
                // comes back was actually re-read. Every other caller reads
                // through the cache unchanged.
                logs: await queryFilterChunked(
                    contract,
                    {},
                    fromBlock,
                    headBlock,
                    undefined,
                    { rescanTail: true }
                ),
            };
        })
    );

    let next = indexState ?? emptyState();
    // The tail eventScan just re-read is the only part of the chain that can
    // have changed shape. `ingest` adds and overwrites but never removes, so a
    // log the chain has since orphaned would outlive its block; dropping the
    // rescanned range first makes the fold a function of the canonical logs
    // that came back. Rewind AFTER the scans resolve: a rejected scan must
    // leave the previous index whole rather than truncated.
    if (next.lastIndexedBlock !== null) {
        next = rewind(next, next.lastIndexedBlock + 1 - REORG_RESCAN_DEPTH);
        // `formatCache` is module state the fold cannot reach, and it caches a
        // `textURI` READ per token for the tab's lifetime. `rewind` drops the
        // creator of a token whose whole history it orphaned, for the reason
        // that applies here too: the canonical chain can put different content
        // behind that id. Every surviving token keeps its entry, so the cache
        // still costs one read per token.
        formatCache = Object.fromEntries(
            Object.entries(formatCache).filter(
                (entry) => entry[0] in next.tokens
            )
        );
    }
    for (const { address, fromBlock, logs } of scans) {
        next = ingest(next, logs, { address, fromBlock, toBlock: headBlock });
    }

    // Creator is `authorOf`, a contract read: neither NFT ABI declares an event
    // that carries one, so no fold can produce it.
    //
    // ponytail: one call per token ever sighted, resolved once and kept on the
    // state so a revisit costs nothing. Three tokens exist on chain 207; past a
    // few thousand this wants a multicall rather than a call each.
    next = await resolveCreators(next, {
        authorOf: (nftAddress, tokenId) =>
            nftContract(nftAddress, readProvider).authorOf(tokenId),
    });

    // The fee split of each sale, and the content type of each listed token.
    // Both are reads, both are resolved once and kept, and both degrade to
    // unknown rather than failing the load: a marketplace with no fee figures
    // is still a marketplace, and a listing with no stated format is still for
    // sale. Only the event scans above are allowed to fail the whole index.
    next = await resolveSettlements(next, readProvider);

    indexState = next;
    return {
        state: next,
        headBlock,
        formats: await resolveFormats(next, readProvider),
    };
}

/**
 * Attach each sale's fee split, derived at that sale's own block.
 *
 * `TokenPurchased` carries no legs and the deployed marketplace emits no
 * fee-change event, while `decreasePlatformFeePercentage` can move the rate at
 * any time. Multiplying volume by today's rate would therefore misreport every
 * sale executed under a different one — an estimate dressed as history. This
 * RPC serves archive state, so the rate and the royalty are read AT THE SALE'S
 * BLOCK instead, and fed to the same `settlementBreakdown` the buy flow uses.
 *
 * The reads are sequential by necessity: `royaltyInfo` is quoted on the
 * remainder AFTER the platform fee (Marketplace.sol:166), so the fee has to be
 * known first. The receipt is fetched as the independent check — the derivation
 * and the ERC-20 legs the buyer actually paid must agree, and `legsAgree`
 * records whether they did.
 *
 * ponytail: three round trips per sale, resolved once per session. Two sales
 * exist on chain 207. Past a few hundred this wants the settlement legs indexed
 * from receipts in the scan itself rather than resolved on demand.
 */
async function resolveSettlements(state, readProvider) {
    const marketplace = new ethers.Contract(
        config.contractAddresses.v1.marketplace,
        v1.marketplace,
        readProvider
    );

    let next = state;
    for (const sale of state.sales) {
        if (next.settlements[sale.id]) {
            continue;
        }
        try {
            const blockTag = sale.blockNumber;
            const platformFeeBps = await marketplace.platformFeePercentage({
                blockTag,
            });
            const total = ethers.BigNumber.from(sale.price).mul(sale.amount);
            const remainder = total.sub(total.mul(platformFeeBps).div(10000));
            const [royaltyReceiver, royaltyAmount] = await nftContract(
                sale.nftAddress,
                readProvider
            ).royaltyInfo(sale.tokenId, remainder, { blockTag });

            next = annotateSale(next, sale.id, {
                platformFeeBps,
                royaltyAmount,
                royaltyReceiver,
                receiptLegs: await receiptLegs(readProvider, sale),
            });
        } catch (e) {
            // A pruned node, a throttled read, a missing receipt: the split for
            // this sale is unknown. It stays unknown, and the sale still counts
            // toward volume.
        }
    }
    return next;
}

/** The ERC-20 legs the buyer paid for one sale, from that sale's own receipt. */
async function receiptLegs(readProvider, sale) {
    const receipt = await readProvider.getTransactionReceipt(
        sale.transactionHash
    );
    const paymentToken = String(sale.paymentToken).toLowerCase();
    const buyer = String(sale.buyer).toLowerCase();

    return (receipt?.logs ?? []).flatMap((log) => {
        if (String(log.address).toLowerCase() !== paymentToken) {
            return [];
        }
        try {
            const { args } = ERC20_TRANSFER.parseLog(log);
            // From the buyer only: `_handleFunds` pulls every leg off the
            // buyer, and any other transfer in the same transaction is
            // somebody else's business.
            return String(args.from).toLowerCase() === buyer
                ? [{ value: args.value.toString() }]
                : [];
        } catch (e) {
            return [];
        }
    });
}

/**
 * The rendered content type of each token that has an active listing.
 *
 * `nftType` is the collection, not the format: every text NFT is "text", but
 * one may be markdown and the next HTML. `textURI` carries the declared MIME,
 * and `deriveTokenType` is the app's single parser for it — the same one the
 * token page renders through, so a card cannot disagree with the page it links
 * to. Image tokens need no read: the collection mints one media kind.
 *
 * ponytail: one read per distinct listed token, cached for the session. Fine
 * at three tokens; a multicall if a real catalogue ever lists thousands.
 */
async function resolveFormats(state, readProvider) {
    for (const listing of Object.values(state.listings)) {
        if (listing.amount <= 0 || !RENDERABLE.includes(listing.nftType)) {
            continue;
        }
        const key = tokenKey(listing.nftAddress, listing.tokenId);
        if (key in formatCache) {
            continue;
        }
        if (listing.nftType === "image") {
            formatCache[key] = "image";
            continue;
        }
        try {
            formatCache[key] = deriveTokenType(
                await nftContract(listing.nftAddress, readProvider).textURI(
                    listing.tokenId
                )
            );
        } catch (e) {
            // An unreadable URI is an unknown format, never a guessed one.
            formatCache[key] = null;
        }
    }
    return { ...formatCache };
}

function nftContract(nftAddress, readProvider) {
    const nftType = nftTypeOf(nftAddress);
    if (!RENDERABLE.includes(nftType)) {
        throw new Error(`Unknown NFT collection: ${nftAddress}`);
    }
    return new ethers.Contract(nftAddress, v1[nftType], readProvider);
}

// `tokenAddressToId` is registered under both the checksummed and the lower-case
// form, so no re-checksumming is needed here.
const paymentTokenId = (address) =>
    address
        ? tokenAddressToId[address] ??
          tokenAddressToId[String(address).toLowerCase()] ??
          null
        : null;

/**
 * Every active listing in the index, in the shape the marketplace page renders.
 *
 * Not a window: the fold covers each contract's whole life, so a listing on the
 * oldest token is as reachable as one on the newest.
 *
 * `sellerBalance` comes from the folded balance map rather than a `balanceOf`
 * call — the scan that produced the listing produced the transfers too, so the
 * answer is already indexed. test/indexer.test.mjs pins that fold against the
 * live `balanceOf` reads for chain 207.
 *
 * The two skip counts are returned rather than swallowed: a row this app cannot
 * render honestly still exists on chain, and a page that drops it silently
 * reports a smaller marketplace than there is.
 */
export function listingRowsFromIndex(state, formats = {}) {
    const rows = [];
    let unrecognisedPaymentToken = 0;
    let unknownCollection = 0;

    for (const listing of Object.values(state.listings)) {
        if (listing.amount <= 0) {
            continue;
        }

        if (!RENDERABLE.includes(listing.nftType)) {
            // No route links it and no ABI reads it, so there is nothing to
            // render. Counted and disclosed, never quietly forgotten.
            unknownCollection += 1;
            continue;
        }

        const paymentToken = paymentTokenId(listing.paymentToken);
        if (!paymentToken) {
            // `listToken` puts no allowlist on the payment token, so the price
            // has no unit this app can state. The LISTING is still real and
            // linkable, so it is rendered without a price rather than dropped;
            // stating it in the wrong unit is the only unacceptable option.
            unrecognisedPaymentToken += 1;
        }

        const key = tokenKey(listing.nftAddress, listing.tokenId);
        const owners = state.balances[key];

        rows.push({
            nftType: listing.nftType,
            tokenId: Number(listing.tokenId),
            listingId: Number(listing.listingId),
            seller: listing.seller,
            amount: listing.amount,
            // Per unit, as the contract stores it: `buyToken` charges
            // price x amount (Marketplace.sol:211). Both forms are carried so
            // the card can state the unit price and the lot total, and the
            // comparator never re-parses a formatted string.
            price: paymentToken
                ? formatTokenAmount(listing.price, paymentToken)
                : null,
            priceRaw: paymentToken ? String(listing.price) : null,
            paymentToken: paymentToken ?? null,
            paymentTokenAddress: listing.paymentToken,
            // A token whose transfers were folded but which has no entry for
            // the seller holds zero, which is known. Only a token the scan
            // never saw is genuinely unknown.
            sellerBalance: owners ? owners[listing.seller] ?? 0 : null,
            // Every unit in existence, folded from the transfers: mints minus
            // burns. Not the listed amount, and not a `totalSupply` read — the
            // scan that found the listing already carries the answer.
            supply: owners
                ? Object.values(owners).reduce((sum, held) => sum + held, 0)
                : null,
            creator: state.tokens[key]?.creator ?? null,
            // Whether that null is an answer or a failed read. The content
            // policy withholds a row whose creator is unknown, so the two must
            // not arrive here as the same value.
            creatorKnown: state.tokens[key]?.creatorKnown ?? false,
            format: formats[key] ?? null,
        });
    }

    return { rows, unrecognisedPaymentToken, unknownCollection };
}

/**
 * One address's whole relationship to both collections, from the index.
 *
 * Owned comes from the folded balances, created from the stored `authorOf`
 * reads, and listed/bought/sold from the marketplace fold — none of them capped
 * at a recent-token window, so an address whose only NFT is token 1 of ten
 * thousand still shows it.
 */
export function profileFromIndex(state, address) {
    const wanted = String(address).toLowerCase();
    const is = (candidate) =>
        Boolean(candidate) && String(candidate).toLowerCase() === wanted;
    // The same renderable filter `listingRowsFromIndex` applies. The
    // marketplace accepts any NFT address, so an indexed token's type can be a
    // raw contract address; AddressPage hands every reference to NFTCard, which
    // looks its config and ABI up BY TYPE and throws building the contract.
    const refOf = (key) => {
        const token = state.tokens[key];
        return token && RENDERABLE.includes(token.nftType)
            ? { type: token.nftType, id: Number(token.tokenId) }
            : null;
    };

    const owned = [];
    for (const [key, owners] of Object.entries(state.balances)) {
        for (const [holder, balance] of Object.entries(owners)) {
            if (is(holder) && balance > 0) {
                const ref = refOf(key);
                if (ref) {
                    owned.push({ ...ref, balance });
                }
            }
        }
    }

    const created = Object.values(state.tokens)
        .filter(
            (token) => is(token.creator) && RENDERABLE.includes(token.nftType)
        )
        .map((token) => ({ type: token.nftType, id: Number(token.tokenId) }));

    const listed = Object.values(state.listings)
        .filter(
            (listing) =>
                listing.amount > 0 &&
                is(listing.seller) &&
                RENDERABLE.includes(listing.nftType)
        )
        .map((listing) => ({
            type: listing.nftType,
            id: Number(listing.tokenId),
        }));

    // A token can be bought or sold repeatedly; these are the tokens involved,
    // not the sale count, so the same token appears once.
    const tokensFromSales = (side) =>
        dedupe(
            state.sales
                .filter((sale) => is(sale[side]))
                .map((sale) => refOf(tokenKey(sale.nftAddress, sale.tokenId)))
                .filter(Boolean)
        );

    return {
        owned: dedupe(owned),
        created: dedupe(created),
        listed: dedupe(listed),
        bought: tokensFromSales("buyer"),
        sold: tokensFromSales("seller"),
    };
}

function dedupe(refs) {
    const seen = new Map();
    for (const ref of refs) {
        const key = `${ref.type}:${ref.id}`;
        if (!seen.has(key)) {
            seen.set(key, ref);
        }
    }
    return [...seen.values()];
}
