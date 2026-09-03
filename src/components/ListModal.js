import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import Joi from "joi";
import { joiResolver } from "@hookform/resolvers/joi";
import ValidatedInput from "./ValidatedInput";
import { schemas } from "../common";
import { useTransactionHelper } from "../common/transaction_status";
import { useRecoilState } from "recoil";
import { formatError, standardErrorState } from "../common/error";
import config from "../config";
import { settlementBreakdown, bpsToPercent } from "../common/settlement";
import {
    exceedsTokenDecimals,
    formatTokenAmount,
    parseTokenAmount,
} from "../common/utils";
import {
    defaultReadProvider,
    useReadProvider,
    useWalletProvider,
} from "../common/provider";
import { ethers } from "ethers";
import { v1 } from "../common/abi";
import BridgeShortcut from "./BridgeShortcut";
import ModalCard from "./ModalCard";

const defaultValues = {
    amount: 1,
    price: "0.1", // Important: this is a string, not a number. That's because Ether prices are strings
};

const etherValidator = (label) => (value, helpers) => {
    const joiSchema = Joi.number().positive().unsafe(true).label(label);

    try {
        Joi.assert(value, joiSchema);
    } catch (e) {
        return helpers.message(e.details[0].message);
    }

    // Check the precision
    if (value.includes(".")) {
        const digitCount = value.split(".")[1].length;
        if (digitCount > 18) {
            return helpers.message(
                `"${label}" must have at most 18 decimal places after the decimal point`
            );
        }
    }

    if (value.endsWith(".")) {
        return value.splice(-1);
    }

    return value;
};

export default function ListModal({
    nftType,
    isOpen,
    setIsOpen,
    onClose,
    balance,
    availableAmount,
    id,
    walletAddress,
    onUpdate,
}) {
    // Settlement terms read from the contracts that will perform the split, so
    // a seller sees what they will actually receive before they list.
    const [platformFeeBps, setPlatformFeeBps] = useState(null);
    const [royaltyBps, setRoyaltyBps] = useState(null);
    const [royaltyReceiver, setRoyaltyReceiver] = useState(null);

    const nftAddress = config.contractAddresses.v1[nftType];
    const nftABI = v1[nftType];
    const marketplaceAddress = config.contractAddresses.v1.marketplace;
    const [readProvider, setReadProvider] = useReadProvider();

    const {
        register,
        formState: { isDirty, isValid, errors },
        handleSubmit,
        watch,
    } = useForm({
        defaultValues,
        mode: "onChange",
        resolver: joiResolver(schemas.list),
    });

    const watchAmount = watch("amount");
    const watchPrice = watch("price");
    const watchPaymentToken = watch("paymentToken");
    const selectedPaymentToken =
        watchPaymentToken || Object.keys(config.tokens)[0];
    const selectedPaymentTokenSymbol =
        config.tokens[selectedPaymentToken]?.symbol;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!nftType || id === undefined || id === null) return;
            try {
                const marketplace = new ethers.Contract(
                    config.contractAddresses.v1.marketplace,
                    ["function platformFeePercentage() view returns (uint16)"],
                    defaultReadProvider
                );
                const nft = new ethers.Contract(
                    nftAddress,
                    [
                        "function royaltyInfo(uint256,uint256) view returns (address,uint256)",
                    ],
                    defaultReadProvider
                );
                const fee = await marketplace.platformFeePercentage();
                const [receiver, quoted] = await nft.royaltyInfo(id, 10000);
                if (cancelled) return;
                setPlatformFeeBps(Number(fee));
                setRoyaltyBps(Number(quoted.toString()));
                setRoyaltyReceiver(receiver);
            } catch (e) {
                if (!cancelled) {
                    // Hide the preview rather than show a figure that may not
                    // match settlement.
                    setPlatformFeeBps(null);
                    setRoyaltyBps(null);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [nftType, id, nftAddress]);

    // The price field's schema allows 18 decimal places for every token, but
    // the selected token decides how many survive parseUnits. The schema
    // cannot see the selection, so the check lives here, where it does.
    const priceDecimals = config.tokens[selectedPaymentToken]?.decimals;
    const priceTooPrecise =
        watchPrice !== undefined &&
        watchPrice !== null &&
        watchPrice !== "" &&
        exceedsTokenDecimals(watchPrice, selectedPaymentToken);

    const proceeds = (() => {
        if (platformFeeBps === null || royaltyBps === null) return null;
        if (!watchPrice || !watchAmount || errors.price || errors.amount)
            return null;
        try {
            const unit = parseTokenAmount(
                String(watchPrice),
                selectedPaymentToken
            );
            const total = unit.mul(ethers.BigNumber.from(String(watchAmount)));
            const remainder = total.sub(total.mul(platformFeeBps).div(10000));
            return settlementBreakdown({
                total,
                platformFeeBps,
                royaltyAmount: remainder.mul(royaltyBps).div(10000),
                royaltyReceiver,
            });
        } catch {
            return null;
        }
    })();

    const closeModal = (data) => {
        setIsOpen(false);
        // console.log("Data:", data);
        if (data) {
            onClose(data.amount, data.paymentToken, data.price);
        }
    };

    const warningMessage = () => {
        let message = "";
        if (availableAmount == 0) {
            message +=
                'You don\'t have any "free" (not tied to listings) tokens. ';
        } else {
            message += `You only have ${availableAmount} "free" (not tied to listings) token${
                availableAmount == 1 ? "" : "s"
            }. `;
        }

        message += `Proceeding will use ${watchAmount - availableAmount} token${
            watchAmount - availableAmount == 1 ? "" : "s"
        } `;
        message +=
            "tied to existing listings, making some listings unfulfillable.";

        return message;
    };

    const handleTransaction = useTransactionHelper();
    const [_, setStandardError] = useRecoilState(standardErrorState);
    const [isApproved, setIsApproved] = useState(false);
    const [walletProvider, setWalletProvider] = useWalletProvider();

    const approveMarketplace = async () => {
        if (!walletProvider) {
            setStandardError("No wallet provider.");
            return;
        }
        if (!id) {
            setStandardError("No id specified.");
            return;
        }

        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            walletProvider
        );

        const contractWithSigner = nftContract.connect(
            walletProvider.getSigner()
        );
        const transactionFunction = async () =>
            await contractWithSigner.setApprovalForAll(
                marketplaceAddress,
                true
            );

        const { success } = await handleTransaction(
            transactionFunction,
            "Approve Marketplace"
        );

        if (success) {
            setIsApproved(true);
            if (onUpdate) {
                onUpdate(id);
            }
        }
    };
    const checkApproval = async () => {
        if (!id || !walletAddress) return;

        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            readProvider
        );

        try {
            const approved = await nftContract.isApprovedForAll(
                walletAddress,
                marketplaceAddress
            );
            setIsApproved(approved);
        } catch (e) {
            console.log(e);
            setStandardError(formatError(e));
        }
    };

    useEffect(() => {
        checkApproval();
    }, [id, walletAddress]);

    if (!isOpen) return <></>;

    return (
        <ModalCard
            title="List NFT"
            onDismiss={() => closeModal(null, null, null)}
        >
            <section className="modal-card-body">
                <p>Balance: {balance}</p>
                {balance != availableAmount ? (
                    <p>Available (not listed) balance: {availableAmount}</p>
                ) : (
                    <></>
                )}
                <ValidatedInput
                    label="Amount"
                    name="amount"
                    type="number"
                    step="1"
                    min="1"
                    errors={errors}
                    register={register}
                />
                {/* Wrapped rather than adjacent: a sibling label associates
                    with nothing, so the currency a seller is pricing in was
                    announced as an unnamed combo box. */}
                <label style={{ display: "block" }} htmlFor="listPaymentToken">
                    Payment Token:
                </label>
                <div className="select">
                    <select id="listPaymentToken" {...register("paymentToken")}>
                        {Object.entries(config.tokens).map(([key, value]) => (
                            <option key={key} value={key}>
                                {value.name}
                            </option>
                        ))}
                    </select>
                </div>
                {selectedPaymentTokenSymbol ? (
                    <BridgeShortcut
                        token={selectedPaymentTokenSymbol}
                        direction="into"
                        variant="quiet"
                    >
                        Buyers can bridge {selectedPaymentTokenSymbol} to
                        VinuChain
                    </BridgeShortcut>
                ) : (
                    <></>
                )}
                <ValidatedInput
                    label={`Price (${selectedPaymentTokenSymbol})`}
                    name="price"
                    type="number"
                    step="0.1"
                    min="0"
                    errors={errors}
                    register={register}
                />

                {proceeds ? (
                    <div
                        className="content is-small mt-2"
                        data-testid="listing-proceeds"
                    >
                        <p className="mb-1">
                            <strong>If it sells at this price</strong>
                        </p>
                        <ul className="mb-1">
                            <li>
                                Buyer pays:{" "}
                                {formatTokenAmount(
                                    proceeds.total.toString(),
                                    selectedPaymentToken
                                )}{" "}
                                {selectedPaymentTokenSymbol}
                            </li>
                            <li>
                                Platform fee ({bpsToPercent(platformFeeBps)}
                                %):{" "}
                                {formatTokenAmount(
                                    proceeds.platformFee.toString(),
                                    selectedPaymentToken
                                )}{" "}
                                {selectedPaymentTokenSymbol}
                            </li>
                            <li>
                                Creator royalty ({bpsToPercent(royaltyBps)}
                                %):{" "}
                                {formatTokenAmount(
                                    proceeds.creatorFee.toString(),
                                    selectedPaymentToken
                                )}{" "}
                                {selectedPaymentTokenSymbol}
                            </li>
                            <li>
                                <strong>
                                    You receive:{" "}
                                    {formatTokenAmount(
                                        proceeds.sellerProceeds.toString(),
                                        selectedPaymentToken
                                    )}{" "}
                                    {selectedPaymentTokenSymbol}
                                </strong>
                            </li>
                        </ul>
                    </div>
                ) : (
                    <></>
                )}

                {priceTooPrecise ? (
                    <p className="notification is-danger">
                        <b>Error</b>: {selectedPaymentTokenSymbol} prices must
                        have at most {priceDecimals} decimal places after the
                        decimal point.
                    </p>
                ) : (
                    <></>
                )}

                {watchAmount > Math.min(balance, availableAmount) ? (
                    watchAmount <= balance ? (
                        <p className="notification is-warning">
                            <b>Warning</b>: {warningMessage()}
                        </p>
                    ) : (
                        <p className="notification is-danger">
                            <b>Error</b>: Cannot list more tokens than you own (
                            {balance}).
                        </p>
                    )
                ) : (
                    <></>
                )}
            </section>
            <footer className="modal-card-foot">
                {!isApproved ? (
                    <button
                        className="button is-black"
                        onClick={approveMarketplace}
                    >
                        Approve Marketplace
                    </button>
                ) : (
                    <button
                        className="button is-black"
                        disabled={
                            (!isValid && isDirty) ||
                            watchAmount > balance ||
                            priceTooPrecise
                        }
                        onClick={handleSubmit(closeModal)}
                    >
                        List
                    </button>
                )}
            </footer>
        </ModalCard>
    );
}
