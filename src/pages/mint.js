import React, { useState } from "react";
import config from "../config";
import { ensProvider, useWalletProvider } from "../common/provider";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import { useForm } from "react-hook-form";
import { joiResolver } from "@hookform/resolvers/joi";
import { schemas } from "../common";
import { MintConfirmModal, MultiEditor } from "../components";
import { Header } from "../components";
import { Helmet } from "react-helmet";

import "bulma/css/bulma.min.css";
import "../styles/globals.css";
import { useTransactionHelper } from "../common/transaction_status";
import { useRecoilState } from "recoil";
import { standardErrorState } from "../common/error";
import StandardErrorDisplay from "../components/StandardErrorDisplay";
import ValidatedInput from "../components/ValidatedInput";
import { mintNft } from "../common/minting";

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
    const handleTransaction = useTransactionHelper();
    const [, setStandardError] = useRecoilState(standardErrorState);
    const [file, setFile] = useState(null);

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

        //await uploadToIpfs(file);

        console.log(file);

        try {
            await mintNft(
                data,
                walletProvider,
                ensProvider,
                handleTransaction,
                setStandardError
            );
        } catch (e) {
            console.log(e);
            setStandardError(e.message);
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
                                    <option value="text/html">HTML</option>
                                </select>
                            </div>
                        </div>
                        <div className="control mt-3">
                            {watchDataType === "image" ? (
                                <div className="box has-text-centered">
                                    <input
                                        type="file"
                                        onChange={(e) =>
                                            setFile(e.target.files[0])
                                        }
                                    />
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
                                <button
                                    className="button is-primary"
                                    disabled={!isValid}
                                    onClick={handleSubmit(
                                        executeTransaction(false)
                                    )}
                                >
                                    Mint
                                </button>
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
