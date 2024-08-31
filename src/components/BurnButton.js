import { navigate } from "gatsby";
import React, { useState } from "react";
import { useRecoilState } from "recoil";

import { useWalletProvider } from "../common/provider";

import BurnModal from "./BurnModal";
import { useTransactionHelper } from "../common/transaction_status";
import { standardErrorState } from "../common/error";
import config from "../config";
import { v1 } from "../common/abi";
import { ethers } from "ethers";

export default function BurnButton({
    nftType,
    id,
    walletAddress,
    balance,
    availableAmount,
    onUpdate,
}) {
    const nftAddress = config.contractAddresses.v1[nftType];
    const nftABI = v1[nftType];

    const handleTransaction = useTransactionHelper();
    const [_, setStandardError] = useRecoilState(standardErrorState);

    const [walletProvider, setWalletProvider] = useWalletProvider();

    const [burnModalOpen, setBurnModalOpen] = useState(false);

    const burn = async (amount) => {
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

        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            walletProvider
        );

        const contractWithSigner = nftContract.connect(
            walletProvider.getSigner()
        );
        const transactionFunction = async () =>
            await contractWithSigner.burn(walletAddress, id, amount);
        const { success } = await handleTransaction(
            transactionFunction,
            `Burn NFT #${id}`
        );

        if (success) {
            if (onUpdate) {
                onUpdate(id);
            }
            if (amount === availableAmount) {
                navigate("/vault");
            }
        }
    };

    return (
        <div>
            <button
                className="button is-black is-small"
                onClick={() => setBurnModalOpen(true)}
            >
                Burn
            </button>
            <BurnModal
                isOpen={burnModalOpen}
                setIsOpen={setBurnModalOpen}
                onClose={burn}
                balance={balance}
                availableAmount={availableAmount}
            />
        </div>
    );
}
