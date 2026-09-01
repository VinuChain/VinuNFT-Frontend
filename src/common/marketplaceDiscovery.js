import { ethers } from "ethers";

/**
 * The one implementation of "which listings match, in what order, on what page".
 *
 * Discovery itself moved to `indexLoader.js`: the marketplace is enumerated by
 * folding every marketplace event, not by reading a window of token ids. What
 * is left here is pure — no provider, no network — so the page and its tests
 * apply the same predicates to the same rows and cannot disagree.
 */

/** Rows per page. Small enough that the first screen is not a wall of cards. */
export const LISTINGS_PAGE_SIZE = 12;

/** A listing's identity, stable across refolds and across ingestion. */
export function listingRowKey(row) {
    return `${row.nftType}:${row.tokenId}:${row.listingId}`;
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

    // An unknown seller balance is unknown AVAILABILITY, not a known shortfall.
    // The row is kept and labelled "Seller balance unavailable" rather than
    // hidden, so the filter never silently shrinks the marketplace on the
    // strength of a read that did not happen.
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

    if (filters.query) {
        const query = String(filters.query).trim();
        if (query) {
            // Two unambiguous shapes only. A token id matches EXACTLY: a prefix
            // match would answer a search for token 1 with token 11, 100 and
            // 1000, which is worse than no search. An address matches by prefix
            // because nobody types 40 hex characters.
            if (/^\d+$/.test(query)) {
                if (String(row.tokenId) !== query) {
                    return false;
                }
            } else if (query.toLowerCase().startsWith("0x")) {
                if (
                    !String(row.seller)
                        .toLowerCase()
                        .startsWith(query.toLowerCase())
                ) {
                    return false;
                }
            } else {
                return false;
            }
        }
    }

    return true;
}

/**
 * Order two listing rows: payment token first, then price, then identity.
 *
 * Payment token comes first on purpose. No price oracle exists in this product
 * (VN-PRICE-001), so there is no defined ordering between 1 ETH and 100 VINU;
 * interleaving them invites exactly the comparison the data cannot support.
 * Grouping by currency keeps every adjacent pair comparable.
 *
 * Within one currency the raw base-unit price decides. Rows carry `priceRaw`,
 * so nothing is re-parsed; the decimal-string fallback is for callers that
 * build rows without it, and it re-parses at 18 decimals rather than through
 * parseFloat, which collapses prices below double resolution.
 *
 * A row with no price sorts last instead of throwing: one listing in an unknown
 * denomination must not take the whole marketplace page down.
 */
export function compareListingRows(left, right) {
    const leftToken = left.paymentToken ?? null;
    const rightToken = right.paymentToken ?? null;
    if (leftToken !== rightToken) {
        if (leftToken === null) return 1;
        if (rightToken === null) return -1;
        return leftToken < rightToken ? -1 : 1;
    }

    const leftPrice = rowPrice(left);
    const rightPrice = rowPrice(right);

    if (leftPrice === null || rightPrice === null) {
        if (leftPrice !== rightPrice) {
            return leftPrice === null ? 1 : -1;
        }
    } else if (!leftPrice.eq(rightPrice)) {
        return leftPrice.lt(rightPrice) ? -1 : 1;
    }

    // Equal prices need a total order, or two pages of the same result set can
    // disagree about which row belongs where.
    return (
        String(left.nftType).localeCompare(String(right.nftType)) ||
        left.tokenId - right.tokenId ||
        left.listingId - right.listingId
    );
}

function rowPrice(row) {
    if (row.priceRaw !== undefined && row.priceRaw !== null) {
        return ethers.BigNumber.from(row.priceRaw);
    }
    try {
        return ethers.utils.parseUnits(String(row.price), 18);
    } catch (e) {
        return null;
    }
}

/**
 * One page of sorted rows, bounded by a cursor rather than an offset.
 *
 * The cursor is a listing's identity, so the boundary survives ingestion: a
 * cheaper listing arriving between renders joins the page it belongs to instead
 * of pushing the last row of every page onto the next one. An unknown cursor
 * restarts at the top — `queryEvents` returns an empty page there, which for a
 * marketplace would blank the results the moment a filter change removed the
 * cursor's row.
 *
 * Pages accumulate: `rows` is everything up to and including the new page, the
 * shape a "Load more" list renders.
 */
export function pageListings(
    rows,
    { cursor = null, pageSize = LISTINGS_PAGE_SIZE } = {}
) {
    const start = cursor
        ? rows.findIndex((row) => listingRowKey(row) === cursor) + 1
        : 0;
    const visible = rows.slice(0, start + pageSize);
    const last = visible[visible.length - 1];

    return {
        rows: visible,
        nextCursor:
            last && visible.length < rows.length ? listingRowKey(last) : null,
        remaining: rows.length - visible.length,
    };
}
