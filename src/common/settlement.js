import { ethers } from "ethers";

const BPS_DENOMINATOR = ethers.BigNumber.from(10000);

/**
 * The exact split a purchase will produce, mirroring Marketplace._handleFunds.
 *
 * Order matters and is not obvious: the platform fee is taken from the whole
 * price first, and the creator royalty is then calculated on what remains —
 * not on the original price. Both use integer division, so the legs must be
 * derived by subtraction rather than computed independently, or rounding
 * leaves the total off by a wei.
 *
 * Defensive bounds match the contract's: a royalty larger than the remainder is
 * clamped to it, and a royalty to the zero address is skipped and stays with
 * the seller. The three legs always sum to exactly `total`.
 *
 * @param total          BigNumber, price * quantity, in payment-token units
 * @param platformFeeBps platformFeePercentage from the marketplace
 * @param royaltyAmount  BigNumber from royaltyInfo(tokenId, remainder), or null
 * @param royaltyReceiver address from royaltyInfo, or null
 */
export function settlementBreakdown({
    total,
    platformFeeBps,
    royaltyAmount = null,
    royaltyReceiver = null,
}) {
    const value = ethers.BigNumber.from(total);
    const bps = ethers.BigNumber.from(platformFeeBps ?? 0);

    const platformFee = value.mul(bps).div(BPS_DENOMINATOR);
    const remainder = value.sub(platformFee);

    let creatorFee = ethers.BigNumber.from(royaltyAmount ?? 0);
    if (creatorFee.gt(remainder)) {
        creatorFee = remainder;
    }
    const payingCreator =
        creatorFee.gt(0) &&
        royaltyReceiver &&
        royaltyReceiver !== ethers.constants.AddressZero;
    if (!payingCreator) {
        creatorFee = ethers.BigNumber.from(0);
    }

    return {
        total: value,
        platformFee,
        creatorFee,
        sellerProceeds: remainder.sub(creatorFee),
    };
}

/** Basis points as a display percentage, e.g. 500 -> "5". */
export function bpsToPercent(bps) {
    return String(Number(bps) / 100);
}
