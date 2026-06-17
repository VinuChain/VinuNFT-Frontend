import { ethers } from "ethers";
import config from "../config";
import { v1 } from "./abi";
import { tokenAddressToId } from "./user";
import { formatTokenAmount } from "./utils";

export const MARKETPLACE_DISCOVERY_WINDOW = 12;
export const MARKETPLACE_LISTINGS_PER_TOKEN_LIMIT = 5;

function paymentTokenId(address) {
    if (!address) {
        return null;
    }

    const checksum = ethers.utils.getAddress(address);
    return (
        tokenAddressToId[checksum] || tokenAddressToId[address.toLowerCase()]
    );
}

export function tokenIdsFromLatest(lastTokenId, windowSize) {
    const ids = [];
    for (let offset = 0; offset < windowSize; offset++) {
        const tokenId = lastTokenId - offset;
        if (tokenId >= 1) {
            ids.push(tokenId);
        }
    }
    return ids;
}

export function rowMatchesFilters(row, filters) {
    if (filters.nftType && filters.nftType !== "all") {
        if (row.nftType !== filters.nftType) {
            return false;
        }
    }

    if (filters.paymentToken && filters.paymentToken !== "all") {
        if (row.paymentToken !== filters.paymentToken) {
            return false;
        }
    }

    if (filters.fulfillableOnly && row.sellerBalance !== null) {
        if (row.sellerBalance < row.amount) {
            return false;
        }
    }

    if (filters.seller) {
        try {
            if (
                ethers.utils.getAddress(row.seller) !==
                ethers.utils.getAddress(filters.seller)
            ) {
                return false;
            }
        } catch (e) {
            return false;
        }
    }

    return true;
}

/**
 * Chunk an array into sub-arrays of at most `size` elements.
 * Used to cap concurrent RPC calls to avoid rate-limiting on the public
 * VinuChain RPC (which may reject large bursts). Chosen concurrency: 8
 * calls per wave — empirically safe for a single-node RPC while still
 * giving a ~10x wall-clock speedup over fully sequential reads.
 */
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

const CONCURRENCY_LIMIT = 8;

/**
 * Run `tasks` (an array of zero-arg async functions) with at most
 * CONCURRENCY_LIMIT in flight at once. Returns results in input order.
 */
async function parallelCapped(tasks) {
    const results = new Array(tasks.length);
    const indexed = tasks.map((fn, i) => [fn, i]);
    for (const chunk of chunkArray(indexed, CONCURRENCY_LIMIT)) {
        const settled = await Promise.all(chunk.map(([fn]) => fn()));
        for (let j = 0; j < chunk.length; j++) {
            results[chunk[j][1]] = settled[j];
        }
    }
    return results;
}

export async function discoverMarketplaceListings(
    readProvider,
    filters = {},
    options = {}
) {
    const windowSize = options.windowSize || MARKETPLACE_DISCOVERY_WINDOW;
    const listingLimit =
        options.listingLimit || MARKETPLACE_LISTINGS_PER_TOKEN_LIMIT;

    const marketplace = new ethers.Contract(
        config.contractAddresses.v1.marketplace,
        v1.marketplace,
        readProvider
    );

    // Resolve both NFT types concurrently. Within each type, all per-token
    // and per-listing reads are also parallelised (capped at CONCURRENCY_LIMIT
    // concurrent calls to avoid overwhelming the public VinuChain RPC).
    const rowsByType = await Promise.all(
        ["text", "image"].map(async (nftType) => {
            if (
                filters.nftType &&
                filters.nftType !== "all" &&
                filters.nftType !== nftType
            ) {
                return [];
            }

            const nftAddress = config.contractAddresses.v1[nftType];
            const nftContract = new ethers.Contract(
                nftAddress,
                v1[nftType],
                readProvider
            );

            const lastTokenId = (await nftContract.lastTokenId()).toNumber();
            const tokenIds = tokenIdsFromLatest(lastTokenId, windowSize);

            // Fetch listingCount for all tokens in this type concurrently.
            const listingCounts = await parallelCapped(
                tokenIds.map((tokenId) => async () =>
                    (
                        await marketplace.listingCount(nftAddress, tokenId)
                    ).toNumber()
                )
            );

            // For each token, fetch all capped listings concurrently.
            const perTokenListings = await parallelCapped(
                tokenIds.map((tokenId, idx) => async () => {
                    const cappedListingCount = Math.min(
                        listingCounts[idx],
                        listingLimit
                    );
                    const listingIds = Array.from(
                        { length: cappedListingCount },
                        (_, i) => i
                    );
                    return parallelCapped(
                        listingIds.map((listingId) => async () =>
                            marketplace.listings(nftAddress, tokenId, listingId)
                        )
                    );
                })
            );

            // Collect valid listings before fetching balances.
            const validListings = [];
            for (let ti = 0; ti < tokenIds.length; ti++) {
                const tokenId = tokenIds[ti];
                const listings = perTokenListings[ti];
                for (let listingId = 0; listingId < listings.length; listingId++) {
                    const listing = listings[listingId];
                    const amount = listing.amount.toNumber();
                    const seller = listing.seller;

                    if (
                        amount <= 0 ||
                        seller === ethers.constants.AddressZero ||
                        !listing.paymentToken
                    ) {
                        continue;
                    }

                    const paymentToken = paymentTokenId(listing.paymentToken);
                    if (!paymentToken) {
                        continue;
                    }

                    validListings.push({
                        tokenId,
                        listingId,
                        seller,
                        amount,
                        listing,
                        paymentToken,
                    });
                }
            }

            // Fetch sellerBalance for each surviving listing concurrently.
            const balances = await parallelCapped(
                validListings.map(({ seller, tokenId }) => async () => {
                    try {
                        return (
                            await nftContract.balanceOf(seller, tokenId)
                        ).toNumber();
                    } catch (e) {
                        return null;
                    }
                })
            );

            return validListings.map((entry, i) => ({
                nftType,
                tokenId: entry.tokenId,
                listingId: entry.listingId,
                seller: entry.seller,
                amount: entry.amount,
                price: formatTokenAmount(entry.listing.price, entry.paymentToken),
                paymentToken: entry.paymentToken,
                sellerBalance: balances[i],
            }));
        })
    );

    const rows = rowsByType.flat();

    const sortDirection = filters.priceSort === "desc" ? -1 : 1;
    return rows
        .filter((row) => rowMatchesFilters(row, filters))
        .sort(
            (left, right) =>
                (parseFloat(left.price) - parseFloat(right.price)) *
                sortDirection
        );
}
