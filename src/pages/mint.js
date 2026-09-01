import React, { useEffect, useState } from "react";
import config from "../config";
import { ensProvider, useWalletProvider } from "../common/provider";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import { set, useForm } from "react-hook-form";
import { joiResolver } from "@hookform/resolvers/joi";
import { schemas } from "../common";
import { MintConfirmModal, MultiEditor } from "../components";
import { Header } from "../components";
import { Helmet } from "react-helmet";

import "bulma/css/bulma.min.css";
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../styles/globals.css";
import { useTransactionHelper } from "../common/transaction_status";
import { useRecoilState } from "recoil";
import { formatError, standardErrorState } from "../common/error";
import StandardErrorDisplay from "../components/StandardErrorDisplay";
import ValidatedInput from "../components/ValidatedInput";
import { estimateTextMintFee, mintNft } from "../common/minting";
import { navigate } from "gatsby";
import { ethers } from "ethers";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faUpload } from "@fortawesome/free-solid-svg-icons";

const allowedFileTypes = ["JPG", "PNG", "GIF"];

const defaultValues = {
    editionSize: 1,
    royaltyPercentage: 10,
    useCustomRecipient: false,
    dataType: "image",
};

export default function Mint() {
    const {
        register,
        formState: { errors, isValid },
        handleSubmit,
        watch,
    } = useForm({
        defaultValues: defaultValues,
        mode: "onChange",
        resolver: joiResolver(schemas.mint),
    });
    const [text, setText] = useState("");
    const [walletProvider] = useWalletProvider();
    const [transactionState] = useState({ status: "noTransaction" });
    const [confirmModalOpen, setConfirmModalOpen] = useState(false);
    const watchUseCustomRecipient = watch(
        "useCustomRecipient",
        defaultValues.useCustomRecipient
    );
    const watchDataType = watch("dataType", defaultValues.dataType);
    const watchTitle = watch("title");
    const watchDescription = watch("description");
    const watchEditionSize = watch("editionSize");
    const watchRoyaltyPercentage = watch("royaltyPercentage");
    const handleTransaction = useTransactionHelper();
    const [, setStandardError] = useRecoilState(standardErrorState);
    const [file, setFile] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [feeEstimate, setFeeEstimate] = useState(null);
    const [isUploading, setIsUploading] = useState(false);

    // Revoking on every change and on unmount stops a long session from
    // holding on to every file the creator browsed through.
    useEffect(() => {
        if (!file) {
            setPreviewUrl(null);
            return;
        }
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [file]);

    const selectFile = (selected) => {
        if (selected && selected.size > config.maxIpfsUploadBytes) {
            // Refusing here spends nothing: the endpoint's own check only
            // fires after the creator has signed an upload intent.
            setStandardError(
                `That image is larger than the ${Math.round(
                    config.maxIpfsUploadBytes / (1024 * 1024)
                )} MiB upload limit.`
            );
            setFile(null);
            return;
        }
        setStandardError(null);
        setFile(selected || null);
    };

    // Only the text path is quoted: it mints directly, so the estimate covers
    // the whole cost. An image mint uploads first, and its calldata does not
    // exist until that upload has happened.
    useEffect(() => {
        if (!walletProvider || watchDataType === "image" || !isValid) {
            setFeeEstimate(null);
            return;
        }

        let cancelled = false;
        // Debounced because every keystroke changes the calldata, and an
        // estimate costs two RPC round-trips through the user's wallet.
        const timer = setTimeout(() => {
            estimateTextMintFee(
                {
                    dataType: watchDataType,
                    title: watchTitle,
                    description: watchDescription,
                    editionSize: watchEditionSize,
                    text,
                    royaltyPercentage: watchRoyaltyPercentage,
                },
                walletProvider
            ).then((fee) => {
                if (!cancelled) {
                    setFeeEstimate(fee);
                }
            });
        }, 400);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [
        walletProvider,
        watchDataType,
        isValid,
        watchTitle,
        watchDescription,
        watchEditionSize,
        watchRoyaltyPercentage,
        text,
    ]);

    const executeTransaction = (mintConfirmed) => async (data) => {
        if (!walletProvider) {
            setStandardError("Please connect a wallet.");
            return;
        }
        // Add non-React Hook Form fields
        data = { ...data, text, image: file };

        if (
            !(data.title && data.description && (data.text || data.image)) &&
            !mintConfirmed
        ) {
            // Open the confirm modal (if it's not already open)
            if (!confirmModalOpen) {
                setConfirmModalOpen(true);
            }
            return;
        }

        setStandardError(null);

        try {
            setIsUploading(true);
            const mintInfo = await mintNft(
                data,
                walletProvider,
                ensProvider,
                handleTransaction,
                setStandardError
            );

            if (!mintInfo.success) {
                // The helper already reported why; repeating "No transaction
                // receipt" here contradicted the toast beside it.
                setStandardError(formatError(mintInfo.error));
                setIsUploading(false);
                return;
            }

            if (mintInfo.receipt) {
                const matchingEvents = (mintInfo.receipt.events || []).filter(
                    (event) =>
                        event.event === "TransferSingle" &&
                        event.args.from === ethers.constants.AddressZero
                );

                if (matchingEvents.length === 0) {
                    throw new Error(
                        "The mint was mined but the receipt carries no new token."
                    );
                }

                const tokenId = matchingEvents[0].args[3].toString();

                const macroType = data.dataType === "image" ? "image" : "text";

                setIsUploading(false);
                navigate(`/nft?type=${macroType}&id=${tokenId}`);
            } else {
                throw new Error("No transaction receipt");
            }
        } catch (e) {
            console.log(e);
            setStandardError(e.message);
            setIsUploading(false);
        }
    };

    return (
        <div>
            <Helmet>
                <title>Mint - VinuNFT</title>
            </Helmet>
            <Header />
            <StandardErrorDisplay />
            <div className="columns m-4">
                <div className="column">
                    <h1 className="title">Mint your NFT</h1>
                    <ValidatedInput
                        label="Title"
                        name="title"
                        type="text"
                        register={register}
                        errors={errors}
                    />
                    <ValidatedInput
                        label="Description"
                        name="description"
                        type="text"
                        register={register}
                        errors={errors}
                    />
                    <ValidatedInput
                        label="Edition size"
                        name="editionSize"
                        type="number"
                        register={register}
                        errors={errors}
                    />
                    <div className="field">
                        <label className="label" htmlFor="content">
                            Content
                        </label>
                        <div className="control">
                            <div className="select">
                                <select {...register("dataType")} id="content">
                                    <option value="image">Image</option>
                                    <option value="text/plain">
                                        Plain Text
                                    </option>
                                    <option value="text/markdown">
                                        Markdown
                                    </option>
                                </select>
                            </div>
                        </div>
                        {watchDataType === "text/markdown" ? (
                            <p className="help">
                                Markdown is sanitized before preview and
                                display.
                            </p>
                        ) : (
                            <></>
                        )}
                        <div className="control mt-3">
                            {watchDataType === "image" ? (
                                <div className="file is-boxed">
                                    <label className="file-label">
                                        <input
                                            className="file-input"
                                            type="file"
                                            // Mirrors the media types the
                                            // upload endpoint accepts, so an
                                            // unsupported file is caught before
                                            // the wallet signature prompt.
                                            accept="image/png,image/jpeg,image/gif,image/webp"
                                            onChange={(e) =>
                                                selectFile(e.target.files[0])
                                            }
                                        />
                                        <span className="file-cta">
                                            <span className="file-icon">
                                                <FontAwesomeIcon
                                                    icon={faUpload}
                                                />
                                            </span>
                                            <span className="file-label">
                                                {" "}
                                                {file?.name ||
                                                    "Choose a file…"}{" "}
                                            </span>
                                        </span>
                                    </label>
                                    {previewUrl ? (
                                        <figure
                                            className="image mt-3"
                                            style={{ maxWidth: "16rem" }}
                                        >
                                            <img
                                                src={previewUrl}
                                                alt={
                                                    file?.name ||
                                                    "Selected image"
                                                }
                                            />
                                        </figure>
                                    ) : (
                                        <></>
                                    )}
                                </div>
                            ) : (
                                <MultiEditor
                                    dataType={watchDataType}
                                    value={text}
                                    setValue={setText}
                                />
                            )}
                        </div>
                        <ValidatedInput
                            label="Royalty percentage"
                            name="royaltyPercentage"
                            type="number"
                            defaultValue="10"
                            min="0"
                            max="100"
                            step="0.01"
                            register={register}
                            errors={errors}
                        />
                        <div className="field">
                            <label className="checkbox label">
                                <input
                                    type="checkbox"
                                    {...register("useCustomRecipient")}
                                    className="mr-1"
                                />
                                Custom royalty recipient
                            </label>
                        </div>
                        {watchUseCustomRecipient ? (
                            <ValidatedInput
                                label="Address"
                                name="customRecipient"
                                type="text"
                                placeholder="0x... or ENS address"
                                register={register}
                                errors={errors}
                            />
                        ) : (
                            <></>
                        )}
                        {walletProvider ? (
                            transactionState.status === "noTransaction" ||
                            transactionState.status === "error" ? (
                                <>
                                    <button
                                        className="button is-primary"
                                        disabled={!isValid || isUploading}
                                        onClick={handleSubmit(
                                            executeTransaction(false)
                                        )}
                                    >
                                        {isUploading ? "Uploading..." : "Mint"}
                                    </button>
                                    {feeEstimate ? (
                                        <p className="help">
                                            Estimated network fee: {feeEstimate}{" "}
                                            {config.nativeCurrency.symbol}
                                        </p>
                                    ) : (
                                        <></>
                                    )}
                                </>
                            ) : (
                                <></>
                            )
                        ) : (
                            <p>Connect a wallet to mint</p>
                        )}
                    </div>
                </div>
                <MintConfirmModal
                    isOpen={confirmModalOpen}
                    setIsOpen={setConfirmModalOpen}
                    onClose={(confirmed) =>
                        handleSubmit(executeTransaction(confirmed))()
                    }
                />
            </div>
        </div>
    );
}
