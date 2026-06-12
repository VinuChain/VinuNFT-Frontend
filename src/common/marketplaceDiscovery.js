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

function tokenIdsFromLatest(lastTokenId, windowSize) {
    const ids = [];
    for (let offset = 0; offset < windowSize; offset++) {
        const tokenId = lastTokenId - offset;
        if (tokenId >= 1) {
            ids.push(tokenId);
        }
    }
    return ids;
}

function rowMatchesFilters(row, filters) {
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

    const rows = [];

    for (const nftType of ["text", "image"]) {
        if (
            filters.nftType &&
            filters.nftType !== "all" &&
            filters.nftType !== nftType
        ) {
            continue;
        }

        const nftAddress = config.contractAddresses.v1[nftType];
        const nftContract = new ethers.Contract(
            nftAddress,
            v1[nftType],
            readProvider
        );
        const lastTokenId = (await nftContract.lastTokenId()).toNumber();
        const tokenIds = tokenIdsFromLatest(lastTokenId, windowSize);

        for (const tokenId of tokenIds) {
            const listingCount = (
                await marketplace.listingCount(nftAddress, tokenId)
            ).toNumber();
            const cappedListingCount = Math.min(listingCount, listingLimit);

            for (
                let listingId = 0;
                listingId < cappedListingCount;
                listingId++
            ) {
                const listing = await marketplace.listings(
                    nftAddress,
                    tokenId,
                    listingId
                );
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

                let sellerBalance = null;
                try {
                    sellerBalance = (
                        await nftContract.balanceOf(seller, tokenId)
                    ).toNumber();
                } catch (e) {
                    sellerBalance = null;
                }

                rows.push({
                    nftType,
                    tokenId,
                    listingId,
                    seller,
                    amount,
                    price: formatTokenAmount(listing.price, paymentToken),
                    paymentToken,
                    sellerBalance,
                });
            }
        }
    }

    const sortDirection = filters.priceSort === "desc" ? -1 : 1;
    return rows
        .filter((row) => rowMatchesFilters(row, filters))
        .sort(
            (left, right) =>
                (parseFloat(left.price) - parseFloat(right.price)) *
                sortDirection
        );
}
