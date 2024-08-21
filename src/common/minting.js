import React from "react";
import { ethers } from "ethers";
import { RoutingLink } from "../components";
import ViewOnExplorer from "../components/ViewOnExplorer";
import config from "../config";
import { v1 } from "./abi";
import Decimal from "decimal.js";
import { uploadFileToIpfs, uploadJSONToIpfs } from "./ipfs";

async function getContentFunction(setStandardError) {
    function contentFunction(status, transaction, success, receipt) {
        if (status !== "success") {
            return null;
        }

        if (success && receipt && receipt.blockNumber) {
            const matchingEvents = receipt.events.filter(
                (event) =>
                    event.event === "TransferSingle" &&
                    event.args.from === ethers.constants.AddressZero
            );
            if (matchingEvents.length === 1) {
                const tokenId = matchingEvents[0].args[3].toString();
                return (
                    <div>
                        <p>
                            <RoutingLink
                                className="is-underlined"
                                href={"/nft?id=" + tokenId}
                            >
                                NFT #{tokenId}
                            </RoutingLink>{" "}
                            minted
                        </p>
                        <p>
                            <ViewOnExplorer hash={transaction.hash} />
                        </p>
                    </div>
                );
            } else {
                setStandardError(
                    "Could not find token ID in transaction receipt."
                );
                return;
            }
        }
    }

    return contentFunction;
}

async function mintImageNft(
    {
        title,
        description,
        editionSize,
        image,
        effectiveRoyaltyPercentage,
        effectiveRoyaltyRecipient,
    },
    walletProvider,
    handleTransaction,
    setStandardError
) {
    const uploadedFileHash = await uploadFileToIpfs(image);

    const metadata = {
        name: title,
        description,
        image: `ipfs://${uploadedFileHash}`,
    };

    const uploadedMetadataHash = await uploadJSONToIpfs(metadata);

    console.log(uploadedFileHash);
    const contractAddress = config.contractAddresses.v1.image;

    const contract = new ethers.Contract(
        contractAddress,
        v1.image,
        walletProvider
    );
    const contractWithSigner = contract.connect(walletProvider.getSigner());

    const contentFunction = await getContentFunction(setStandardError);

    async function transactionFunction() {
        return await contractWithSigner.mint(
            `ipfs://${uploadedMetadataHash}`,
            editionSize,
            effectiveRoyaltyPercentage,
            effectiveRoyaltyRecipient,
            0
        );
    }

    handleTransaction(transactionFunction, "Mint", contentFunction);
}

async function mintTextNft(
    {
        dataType,
        title,
        description,
        editionSize,
        text,
        effectiveRoyaltyPercentage,
        effectiveRoyaltyRecipient,
    },
    walletProvider,
    handleTransaction,
    setStandardError
) {
    const isUTF8 = [...text].some((char) => char.charCodeAt(0) > 127);

    const uri =
        "data:" +
        dataType +
        (isUTF8 && dataType === "text/plain" ? ",charset=UTF-8" : "") +
        "," +
        encodeURIComponent(text);

    const contractAddress = config.contractAddresses.v1.zang;

    const contract = new ethers.Contract(
        contractAddress,
        v1.zang,
        walletProvider
    );
    const contractWithSigner = contract.connect(walletProvider.getSigner());

    const contentFunction = await getContentFunction(setStandardError);

    async function transactionFunction() {
        return await contractWithSigner.mint(
            uri,
            title,
            description,
            editionSize,
            effectiveRoyaltyPercentage,
            effectiveRoyaltyRecipient,
            0
        );
    }

    handleTransaction(transactionFunction, "Mint", contentFunction);
}

async function mintNft(
    {
        dataType,
        title,
        description,
        editionSize,
        text,
        image,
        royaltyPercentage,
        useCustomRecipient,
        customRecipient,
    },
    walletProvider,
    ensProvider,
    handleTransaction,
    setStandardError
) {
    const effectiveRoyaltyPercentage = new Decimal(royaltyPercentage)
        .mul("100")
        .toNumber();

    let effectiveRoyaltyRecipient = null;

    if (useCustomRecipient) {
        effectiveRoyaltyRecipient = customRecipient;

        if (effectiveRoyaltyRecipient.includes(".eth")) {
            let resolvedAddress = null;
            try {
                resolvedAddress = await ensProvider.resolveName(
                    effectiveRoyaltyRecipient
                );
            } catch (e) {
                setStandardError(
                    'Invalid custom recipient address: "' + e.message + '".'
                );
                return;
            }

            if (resolvedAddress) {
                effectiveRoyaltyRecipient = resolvedAddress;
            } else {
                setStandardError("Could not resolve ENS name.");
                return;
            }
        }
    } else {
        try {
            effectiveRoyaltyRecipient = await walletProvider
                .getSigner()
                .getAddress();
        } catch (e) {
            setStandardError(
                'Could not retrieve wallet address: "' + e.message + '".'
            );
            return;
        }
    }

    if (dataType === "image") {
        await mintImageNft(
            {
                title,
                description,
                editionSize,
                image,
                effectiveRoyaltyPercentage,
                effectiveRoyaltyRecipient,
            },
            walletProvider,
            handleTransaction,
            setStandardError
        );
    } else {
        await mintTextNft(
            {
                dataType,
                title,
                description,
                editionSize,
                text,
                effectiveRoyaltyPercentage,
                effectiveRoyaltyRecipient,
            },
            walletProvider,
            handleTransaction,
            setStandardError
        );
    }
}

export { mintNft };
