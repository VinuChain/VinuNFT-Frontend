import React, { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { joiResolver } from "@hookform/resolvers/joi";
import ValidatedInput from "./ValidatedInput";
import { schemas } from "../common";
import { FixedNumber, ethers } from "ethers";
import { defaultReadProvider, useWalletProvider } from "../common/provider";
import { useRecoilState } from "recoil";
import { tokenAllowancesState } from "../common/user";
import config from "../config";
import { useTransactionHelper } from "../common/transaction_status";
import { formatTokenAmount, parseTokenAmount } from "../common/utils";
import BridgeShortcut from "./BridgeShortcut";

const styles = {
    modalCard: {
        maxWidth: "80vw",
    },
    modalCardTitle: {
        overflowWrap: "break-word",
        maxWidth: "70vw",
    },
};

const defaultValues = {
    amount: 1,
};

export default function BuyModal({
    nftId,
    isOpen,
    setIsOpen,
    onClose,
    maxAmount,
    sellerBalance,
    price,
    paymentToken,
    onUpdate,
}) {
    const [walletProvider, setWalletProvider] = useWalletProvider();
    const [tokenAllowances, setTokenAllowances] =
        useRecoilState(tokenAllowancesState);
    const handleTransaction = useTransactionHelper();

    const allowance = tokenAllowances[paymentToken];

    const [paymentTokenBalance, setPaymentTokenBalance] = useState(null);

    const {
        register,
        formState: { isDirty, isValid, errors },
        handleSubmit,
        watch,
    } = useForm({
        defaultValues,
        mode: "onChange",
        resolver: joiResolver(schemas.buy),
    });

    const watchAmount = watch("amount", defaultValues.amount);

    const validAmount = () => watchAmount <= Math.min(maxAmount, sellerBalance);
    const validPaymentTokenBalance = () =>
        total() &&
        paymentTokenBalance !== null &&
        parseFloat(paymentTokenBalance) >= parseFloat(total());

    const closeModal = (data) => {
        if (data) {
            onClose(data.amount);
        }
        setIsOpen(false);
    };

    const total = () => {
        if (!watchAmount || price <= 0) {
            return undefined;
        }
        try {
            return FixedNumber.from(watchAmount)
                .mulUnsafe(FixedNumber.from(price))
                .toString();
        } catch (e) {
            console.log("Error: ", e);
            return undefined;
        }
    };

    async function queryPaymentTokenBalance() {
        if (!walletProvider) {
            return;
        }

        const signer = await walletProvider.getSigner();
        const signerAddress = await signer.getAddress();

        const tokenContract = new ethers.Contract(
            config.tokens[paymentToken].address,
            ["function balanceOf(address owner) view returns (uint256)"],
            defaultReadProvider
        );

        console.log("Token contract:", tokenContract);
        console.log("Signer address:", signerAddress);

        const balance = await tokenContract.balanceOf(signerAddress);

        console.log("Balance:", balance.toString());
        setPaymentTokenBalance(
            formatTokenAmount(balance.toString(), paymentToken)
        );
    }
    useEffect(() => {
        queryPaymentTokenBalance();
    }, [walletProvider, paymentToken]);

    async function approve() {
        const tokenContract = new ethers.Contract(
            config.tokens[paymentToken].address,
            ["function approve(address,uint256)"],
            walletProvider
        );

        async function doApproval() {
            return await tokenContract
                .connect(walletProvider.getSigner())
                .approve(
                    config.contractAddresses.v1.marketplace,
                    parseTokenAmount(total(), paymentToken)
                );
        }

        // console.log("Approving...");

        const { success } = await handleTransaction(
            doApproval,
            `Approve ${total()} ${config.tokens[paymentToken].symbol}`
        );
        if (success && onUpdate) {
            onUpdate(nftId);
        }
    }

    if (!isOpen) return <></>;

    const totalAmount = total();
    const paymentTokenSymbol = config.tokens[paymentToken].symbol;
    const hasValidTotal = totalAmount && errors.amount === undefined;
    const parsedTotal = totalAmount
        ? parseTokenAmount(totalAmount, paymentToken)
        : null;
    const hasEnoughAllowance =
        allowance && parsedTotal && allowance.gte(parsedTotal);
    const disableAction =
        (!isValid && isDirty) || !validAmount() || !validPaymentTokenBalance();

    return (
        <div className="modal is-active">
            <div
                className="modal-background"
                onClick={() => closeModal(null, null)}
            />
            <div className="modal-card" style={styles.modalCard}>
                <header className="modal-card-head">
                    <p
                        className="modal-card-title"
                        style={styles.modalCardTitle}
                    >
                        Buy NFT
                    </p>
                </header>
                <section className="modal-card-body">
                    <p>Listed quantity: {maxAmount}</p>
                    {sellerBalance < maxAmount ? (
                        <p>Seller's balance: {sellerBalance}</p>
                    ) : (
                        <></>
                    )}
                    <p>Price: {price}</p>
                    <ValidatedInput
                        label="Amount"
                        name="amount"
                        type="number"
                        step="1"
                        min="1"
                        errors={errors}
                        register={register}
                    />
                    {hasValidTotal ? (
                        <>
                            <p>
                                Total: {totalAmount} {paymentTokenSymbol}
                            </p>
                            <p>
                                Your balance:{" "}
                                {paymentTokenBalance === null
                                    ? "Loading..."
                                    : paymentTokenBalance}{" "}
                                {paymentTokenSymbol}
                            </p>
                            <BridgeShortcut
                                token={paymentTokenSymbol}
                                direction="into"
                                variant="quiet"
                            />
                        </>
                    ) : (
                        <p>Total: </p>
                    )}
                    {hasValidTotal &&
                    paymentTokenBalance !== null &&
                    !validPaymentTokenBalance() ? (
                        <p className="notification is-danger">
                            <b>Error</b>: Insufficient balance.{" "}
                            <BridgeShortcut
                                token={paymentTokenSymbol}
                                direction="into"
                                variant="danger"
                            >
                                Bridge {paymentTokenSymbol} to VinuChain
                            </BridgeShortcut>
                        </p>
                    ) : (
                        <></>
                    )}
                    {validAmount() ? (
                        <></>
                    ) : (
                        <p className="notification is-danger">
                            <b>Error</b>:
                            {watchAmount <= maxAmount
                                ? ` Cannot buy more tokens than the seller's balance (${sellerBalance}).`
                                : ` Cannot buy more tokens than the listed amount (${maxAmount}).`}
                        </p>
                    )}
                </section>
                <footer className="modal-card-foot">
                    {hasEnoughAllowance ? (
                        <button
                            className="button is-black"
                            disabled={disableAction}
                            onClick={handleSubmit(closeModal)}
                        >
                            Buy
                        </button>
                    ) : (
                        <button
                            className="button is-black"
                            disabled={disableAction}
                            onClick={approve}
                        >
                            Approve {totalAmount || ""}{" "}
                            {config.tokens[paymentToken].symbol}
                        </button>
                    )}
                </footer>
            </div>
        </div>
    );
}
