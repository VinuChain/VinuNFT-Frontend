import React, { useState } from "react";

import { useWalletProvider, ensProvider } from "../common/provider";

import TransferModal from "./TransferModal";
import { useTransactionHelper } from "../common/transaction_status";
import { useRecoilState } from "recoil";
import { standardErrorState } from "../common/error";

export default function TransferButton({
    nftContract,
    id,
    walletAddress,
    balance,
    availableAmount,
    onUpdate,
}) {
    const [walletProvider, setWalletProvider] = useWalletProvider();

    const handleTransaction = useTransactionHelper();

    const [transferModalOpen, setTransferModalOpen] = useState(false);

    const [_, setStandardError] = useRecoilState(standardErrorState);

    const transfer = async (to, amount) => {
        if (to === null) {
            setStandardError("Please enter a valid address.");
            return;
        }

        if (amount === null) {
            setStandardError("Please enter an amount.");
            return;
        }

        if (!id) {
            setStandardError("Could not determine the ID of the NFT.");
            return;
        }
        if (!walletProvider) {
            setStandardError("Please connect a wallet.");
            return;
        }

        setStandardError(null);

        if (to.includes(".eth")) {
            to = ensProvider.resolveName(to);
        }

        const contractWithSigner = nftContract.connect(
            walletProvider.getSigner()
        );

        const transactionFunction = async () =>
            await contractWithSigner.safeTransferFrom(
                walletAddress,
                to,
                id,
                amount,
                []
            );
        const { success } = await handleTransaction(
            transactionFunction,
            `Transfer NFT #${id}`
        );
        if (success && onUpdate) {
            onUpdate(id);
        }
    };

    return (
        <div>
            <button
                className="button is-black is-small mr-1"
                onClick={() => setTransferModalOpen(true)}
            >
                Gift
            </button>
            <TransferModal
                isOpen={transferModalOpen}
                setIsOpen={setTransferModalOpen}
                onClose={transfer}
                balance={balance}
                availableAmount={availableAmount}
            />
        </div>
    );
}
