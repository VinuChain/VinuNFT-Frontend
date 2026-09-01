import { ethers } from "ethers";
import { tokenAddressToId } from "./user";

/**
 * Marketplace metrics, derived only from what the index actually knows.
 *
 * A pure fold over `indexer.js` state: no network, no estimate, no smoothing.
 * Every figure below has an exact definition stated beside it, and anything
 * without one is not computed at all — see the refusals at the bottom of
 * `docs/marketplace-discovery.md`.
 *
 * Money is ALWAYS keyed by payment token and returned in that token's base
 * units as a string. There is no cross-currency aggregate anywhere in this
 * module: no price oracle is integrated (VN-PRICE-001), so a single "volume"
 * or "floor" across WVC, USDT, VINU and ETH would be fabricated. Counts of
 * things (sales, units, listings, addresses) are currency-free, so those are
 * the only global totals here.
 */

const ZERO = ethers.BigNumber.from(0);

// Registered under both the checksummed and the lower-case form.
const paymentTokenId = (address) =>
    address
        ? tokenAddressToId[address] ??
          tokenAddressToId[String(address).toLowerCase()] ??
          null
        : null;

function emptyBucket(paymentToken) {
    return {
        paymentToken,
        // SALES: one per TokenPurchased log. A purchase of 4 units is one sale.
        salesCount: 0,
        // UNITS SOLD: SUM(_amount), the number of NFT editions that changed
        // hands, which is not the sale count.
        unitsSold: 0,
        // VOLUME: SUM(_price x _amount). `_price` is the PER-UNIT price
        // (Marketplace.sol:196 reads the listing's unit price, :211 charges
        // `price * _amount`), so summing `_price` alone under-reports any
        // multi-unit sale.
        volume: ZERO,
        // FEES, ROYALTIES, PROCEEDS: the three legs of `_handleFunds`, derived
        // per sale from `platformFeePercentage()` and `royaltyInfo()` read AT
        // THAT SALE'S BLOCK. They cover only the sales whose historical reads
        // succeeded; `salesMissingSettlement` says how many they do not cover.
        platformFees: ZERO,
        royalties: ZERO,
        sellerProceeds: ZERO,
        salesMissingSettlement: 0,
        // How many of the covered splits reproduce the ERC-20 legs the buyer
        // actually paid. Anything below `salesCount - salesMissingSettlement`
        // means the derivation and the chain disagree, and the UI must say so.
        settlementsReconciled: 0,
        lastSale: null,
        activeListings: 0,
        floorUnitPrice: null,
    };
}

export function marketplaceMetrics(state) {
    const byPaymentToken = {};
    const bucketFor = (paymentToken) => {
        byPaymentToken[paymentToken] ??= emptyBucket(paymentToken);
        return byPaymentToken[paymentToken];
    };

    const buyers = new Set();
    const sellers = new Set();
    let salesCount = 0;
    let unitsSold = 0;
    let unpricedSales = 0;

    for (const sale of state.sales) {
        salesCount += 1;
        unitsSold += Number(sale.amount);
        buyers.add(String(sale.buyer).toLowerCase());
        sellers.add(String(sale.seller).toLowerCase());

        const paymentToken = paymentTokenId(sale.paymentToken);
        if (!paymentToken) {
            // The sale happened; its size has no unit this app can state.
            unpricedSales += 1;
            continue;
        }

        const bucket = bucketFor(paymentToken);
        const total = ethers.BigNumber.from(sale.price).mul(sale.amount);
        bucket.salesCount += 1;
        bucket.unitsSold += Number(sale.amount);
        bucket.volume = bucket.volume.add(total);

        // Sales arrive in block order from the fold, so the last one wins.
        bucket.lastSale = {
            price: String(sale.price),
            amount: Number(sale.amount),
            block: sale.blockNumber,
        };

        if (sale.settlement) {
            bucket.platformFees = bucket.platformFees.add(
                sale.settlement.platformFee
            );
            bucket.royalties = bucket.royalties.add(sale.settlement.creatorFee);
            bucket.sellerProceeds = bucket.sellerProceeds.add(
                sale.settlement.sellerProceeds
            );
            if (sale.settlement.legsAgree) {
                bucket.settlementsReconciled += 1;
            }
        } else {
            bucket.salesMissingSettlement += 1;
        }
    }

    // LISTINGS CREATED: distinct (nftAddress, tokenId, listingId) triples ever
    // seen. NOT the TokenListed count: `editListing` re-emits TokenListed under
    // the same listing id, and on chain 207 seven events carry two ids.
    const listingsCreated = Object.keys(state.listings).length;

    let activeListings = 0;
    let unpricedActiveListings = 0;
    for (const listing of Object.values(state.listings)) {
        if (listing.amount <= 0) {
            continue;
        }
        activeListings += 1;

        const paymentToken = paymentTokenId(listing.paymentToken);
        if (!paymentToken) {
            unpricedActiveListings += 1;
            continue;
        }

        const bucket = bucketFor(paymentToken);
        bucket.activeListings += 1;

        // FLOOR: the lowest PER-UNIT price among listings that are active right
        // now in this payment token. Per unit, not per lot — one unit at 60 is
        // a cheaper way in than three at 50, and a lot-price floor would say
        // the opposite. Listings whose seller may not hold the units are
        // included: fulfillability is a separate, separately-labelled fact, and
        // excluding them would make the floor depend on a balance inference.
        const price = ethers.BigNumber.from(listing.price);
        if (bucket.floorUnitPrice === null || price.lt(bucket.floorUnitPrice)) {
            bucket.floorUnitPrice = price;
        }
    }

    for (const bucket of Object.values(byPaymentToken)) {
        bucket.volume = bucket.volume.toString();
        bucket.platformFees = bucket.platformFees.toString();
        bucket.royalties = bucket.royalties.toString();
        bucket.sellerProceeds = bucket.sellerProceeds.toString();
        bucket.floorUnitPrice = bucket.floorUnitPrice?.toString() ?? null;
    }

    return {
        byPaymentToken,
        salesCount,
        unitsSold,
        // Distinct addresses, so currency-free and safe to state globally.
        buyers: buyers.size,
        sellers: sellers.size,
        listingsCreated,
        activeListings,
        unpricedActiveListings,
        unpricedSales,
    };
}
