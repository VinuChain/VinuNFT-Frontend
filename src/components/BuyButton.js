import React from "react";
import { useState } from "react";
import config from "../config";
import { ethers } from "ethers";
import { v1 } from "../common/abi";
import { useRecoilState } from "recoil";
import { formatError, standardErrorState } from "../common/error";
import { tokenAddressToId } from "../common/user";

import { useReadProvider, useWalletProvider } from "../common/provider";

import BuyModal from "./BuyModal";
import { useTransactionHelper } from "../common/transaction_status";
import { parseTokenAmount } from "../common/utils";

export default function BuyButton({
    nftType,
    nftId,
    listingId,
    price,
    paymentToken,
    maxAmount,
    sellerBalance,
    onUpdate,
}) {
    sellerBalance = sellerBalance || 0;

    const nftAddress = config.contractAddresses.v1[nftType];
    const marketplaceAddress = config.contractAddresses.v1.marketplace;
    const marketplaceABI = v1.marketplace;

    const [readProvider, setReadProvider] = useReadProvider();
    const [walletProvider, setWalletProvider] = useWalletProvider();
    const [_, setStandardError] = useRecoilState(standardErrorState);

    const handleTransaction = useTransactionHelper();

    const [buyModalOpen, setBuyModalOpen] = useState(false);

    const buy = async (amount) => {
        if (amount === null) {
            setStandardError("Please enter an amount.");
            return;
        }

        if (!nftId) {
            setStandardError("Could not determine the ID of the NFT.");
            return;
        }
        if (!walletProvider) {
            setStandardError("Please connect a wallet.");
            return;
        }

        setStandardError(null);

        const contract = new ethers.Contract(
            marketplaceAddress,
            marketplaceABI,
            walletProvider
        );
        const contractWithSigner = contract.connect(walletProvider.getSigner());

        // Convert to wei
        // console.log("Original price:", price);
        const parsedPrice = parseTokenAmount(price, paymentToken);
        // console.log("Converted:", price.toString());

        // Re-read the listing the buyer is actually about to pay for. The
        // price, quantity and the seller's approval on screen are a snapshot
        // that anyone can invalidate between render and signature; this
        // narrows that window and, more importantly, replaces an opaque
        // revert with a reason. The contract's expected-price argument
        // remains the real protection.
        let listingInfo;
        let sellerApproved;
        try {
            listingInfo = await contract.getListing(
                nftAddress,
                nftId,
                listingId
            );
            const nftContract = new ethers.Contract(
                nftAddress,
                v1[nftType],
                walletProvider
            );
            sellerApproved = await nftContract.isApprovedForAll(
                listingInfo.seller,
                marketplaceAddress
            );
        } catch (e) {
            setStandardError(
                `Could not check the listing before buying: ${formatError(e)}`
            );
            return;
        }

        if (listingInfo.seller === ethers.constants.AddressZero) {
            setStandardError(
                "This listing is no longer available. Refresh and try again."
            );
            return;
        }
        if (
            tokenAddressToId[listingInfo.paymentToken] !== paymentToken ||
            !listingInfo.price.eq(parsedPrice)
        ) {
            setStandardError(
                "The price of this listing changed. Refresh to see the current price."
            );
            return;
        }
        if (listingInfo.amount.lt(amount)) {
            setStandardError(
                `Only ${listingInfo.amount.toString()} of this listing is left. Refresh and try again.`
            );
            return;
        }
        if (!sellerApproved) {
            setStandardError(
                "The seller has withdrawn the marketplace's permission to move these tokens, so this listing cannot be filled."
            );
            return;
        }

        const transactionFunction = async () =>
            await contractWithSigner.buyToken(
                nftAddress,
                nftId,
                listingId,
                amount,
                parsedPrice
            );
        const { success } = await handleTransaction(
            transactionFunction,
            `Buy NFTs #${nftId}`
        );
        if (success && onUpdate) {
            onUpdate(nftId);
        }
    };

    return (
        <div>
            <button
                className="button is-black"
                disabled={sellerBalance === 0}
                onClick={() => setBuyModalOpen(true)}
            >
                Buy
            </button>
            <BuyModal
                nftType={nftType}
                nftId={nftId}
                isOpen={buyModalOpen}
                setIsOpen={setBuyModalOpen}
                onClose={buy}
                maxAmount={maxAmount}
                sellerBalance={sellerBalance}
                price={price}
                paymentToken={paymentToken}
                onUpdate={onUpdate}
            />
        </div>
    );
}
