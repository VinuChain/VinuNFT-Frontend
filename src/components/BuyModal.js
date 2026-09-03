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
import { settlementBreakdown, bpsToPercent } from "../common/settlement";
import ModalCard from "./ModalCard";

const defaultValues = {
    amount: 1,
};

export default function BuyModal({
    nftType,
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
    // The raw balance is kept beside the formatted one because sufficiency has
    // to be decided in the token's own units: a double parsed from an
    // 18-decimal string cannot tell "exactly the price" from "one wei short".
    const [paymentTokenBalanceRaw, setPaymentTokenBalanceRaw] = useState(null);
    // Settlement terms, read from the same contracts that will perform the
    // split. null until loaded, so a breakdown is never shown as a guess.
    const [platformFeeBps, setPlatformFeeBps] = useState(null);
    const [royaltyBps, setRoyaltyBps] = useState(null);
    const [royaltyReceiver, setRoyaltyReceiver] = useState(null);

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
    const validPaymentTokenBalance = (parsedTotal) =>
        parsedTotal !== null &&
        paymentTokenBalanceRaw !== null &&
        paymentTokenBalanceRaw.gte(parsedTotal);

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
        setPaymentTokenBalanceRaw(balance);
        setPaymentTokenBalance(
            formatTokenAmount(balance.toString(), paymentToken)
        );
    }
    useEffect(() => {
        queryPaymentTokenBalance();
    }, [walletProvider, paymentToken]);

    async function querySettlementTerms() {
        if (!nftType) return;
        try {
            const marketplace = new ethers.Contract(
                config.contractAddresses.v1.marketplace,
                ["function platformFeePercentage() view returns (uint16)"],
                defaultReadProvider
            );
            const nft = new ethers.Contract(
                config.contractAddresses.v1[nftType],
                [
                    "function royaltyInfo(uint256,uint256) view returns (address,uint256)",
                ],
                defaultReadProvider
            );

            const fee = await marketplace.platformFeePercentage();
            // Quote the royalty against a round denominator so the rate can be
            // reapplied to whatever quantity the buyer picks. The contract
            // quotes it against the post-fee remainder at settlement time.
            const [receiver, quoted] = await nft.royaltyInfo(nftId, 10000);

            setPlatformFeeBps(Number(fee));
            setRoyaltyBps(Number(quoted.toString()));
            setRoyaltyReceiver(receiver);
        } catch (e) {
            // Leaving these null hides the breakdown rather than showing a
            // figure that may not match settlement.
            setPlatformFeeBps(null);
            setRoyaltyBps(null);
        }
    }
    useEffect(() => {
        querySettlementTerms();
    }, [nftType, nftId]);

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
    // Mirrors Marketplace._handleFunds exactly; parity with 128 executed
    // purchases is asserted in test/settlementParity.test.mjs.
    const feeBreakdown =
        hasValidTotal && platformFeeBps !== null && royaltyBps !== null
            ? (() => {
                  const total = parseTokenAmount(totalAmount, paymentToken);
                  const remainder = total.sub(
                      total.mul(platformFeeBps).div(10000)
                  );
                  return settlementBreakdown({
                      total,
                      platformFeeBps,
                      royaltyAmount: remainder.mul(royaltyBps).div(10000),
                      royaltyReceiver,
                  });
              })()
            : null;
    const parsedTotal = totalAmount
        ? parseTokenAmount(totalAmount, paymentToken)
        : null;
    const hasEnoughAllowance =
        allowance && parsedTotal && allowance.gte(parsedTotal);
    const disableAction =
        (!isValid && isDirty) ||
        !validAmount() ||
        !validPaymentTokenBalance(parsedTotal);

    return (
        <ModalCard title="Buy NFT" onDismiss={() => closeModal(null, null)}>
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
                        {feeBreakdown ? (
                            <div
                                className="content is-small mt-2"
                                data-testid="fee-breakdown"
                            >
                                <p className="mb-1">
                                    <strong>Where your payment goes</strong>
                                </p>
                                <ul className="mb-1">
                                    <li>
                                        Creator royalty (
                                        {bpsToPercent(royaltyBps)}%):{" "}
                                        {formatTokenAmount(
                                            feeBreakdown.creatorFee.toString(),
                                            paymentToken
                                        )}{" "}
                                        {paymentTokenSymbol}
                                    </li>
                                    <li>
                                        Platform fee (
                                        {bpsToPercent(platformFeeBps)}%):{" "}
                                        {formatTokenAmount(
                                            feeBreakdown.platformFee.toString(),
                                            paymentToken
                                        )}{" "}
                                        {paymentTokenSymbol}
                                    </li>
                                    <li>
                                        Seller receives:{" "}
                                        {formatTokenAmount(
                                            feeBreakdown.sellerProceeds.toString(),
                                            paymentToken
                                        )}{" "}
                                        {paymentTokenSymbol}
                                    </li>
                                </ul>
                                <p className="is-italic">
                                    You pay {totalAmount} {paymentTokenSymbol}{" "}
                                    in total. The royalty is taken from the
                                    amount left after the platform fee.
                                </p>
                            </div>
                        ) : (
                            <></>
                        )}
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
                !validPaymentTokenBalance(parsedTotal) ? (
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
        </ModalCard>
    );
}
