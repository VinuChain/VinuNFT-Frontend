import React from "react";
import { ethers } from "ethers";
import { RoutingLink } from "../components";
import ViewOnExplorer from "../components/ViewOnExplorer";
import config from "../config";
import { v1 } from "./abi";
import Decimal from "decimal.js";
import { clearUploadCache, uploadFileToIpfs, uploadJSONToIpfs } from "./ipfs";
import { estimateFee } from "./utils";

async function getContentFunction(nftType) {
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
                                href={`/nft?type=${nftType}&id=${tokenId}`}
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
                throw new Error(
                    "Could not find token ID in transaction receipt."
                );
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
    handleTransaction
) {
    const uploadedFileHash = await uploadFileToIpfs(image, walletProvider);

    const metadata = {
        name: title,
        description,
        image: `ipfs://${uploadedFileHash}`,
    };

    const uploadedMetadataHash = await uploadJSONToIpfs(
        metadata,
        walletProvider
    );

    // console.log(uploadedFileHash);
    const contractAddress = config.contractAddresses.v1.image;

    const contract = new ethers.Contract(
        contractAddress,
        v1.image,
        walletProvider
    );
    const contractWithSigner = contract.connect(walletProvider.getSigner());

    const contentFunction = await getContentFunction("image");

    async function transactionFunction() {
        return await contractWithSigner.mint(
            `ipfs://${uploadedMetadataHash}`,
            editionSize,
            effectiveRoyaltyPercentage,
            effectiveRoyaltyRecipient,
            0
        );
    }

    const result = await handleTransaction(
        transactionFunction,
        "Mint",
        contentFunction
    );

    if (result.success) {
        clearUploadCache();
    }

    return result;
}

function textTokenUri(dataType, text) {
    const isUTF8 = [...text].some((char) => char.charCodeAt(0) > 127);

    return (
        "data:" +
        dataType +
        (isUTF8 && dataType === "text/plain" ? ",charset=UTF-8" : "") +
        "," +
        encodeURIComponent(text)
    );
}

/**
 * Estimated network fee for the text mint the form currently describes, so the
 * page can quote a cost without knowing which contract it will call.
 */
async function estimateTextMintFee(
    { dataType, title, description, editionSize, text, royaltyPercentage },
    walletProvider
) {
    try {
        const signer = walletProvider.getSigner();
        const contract = new ethers.Contract(
            config.contractAddresses.v1.text,
            v1.text,
            signer
        );

        const args = [
            textTokenUri(dataType, text),
            title,
            description,
            editionSize,
            new Decimal(royaltyPercentage).mul("100").toNumber(),
            await signer.getAddress(),
            0,
        ];

        return await estimateFee(
            () => contract.estimateGas.mint(...args),
            contract.provider
        );
    } catch {
        return null;
    }
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
    handleTransaction
) {
    const uri = textTokenUri(dataType, text);

    const contractAddress = config.contractAddresses.v1.text;

    const contract = new ethers.Contract(
        contractAddress,
        v1.text,
        walletProvider
    );
    const contractWithSigner = contract.connect(walletProvider.getSigner());

    const contentFunction = await getContentFunction("text");

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

    return handleTransaction(transactionFunction, "Mint", contentFunction);
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
    handleTransaction
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
                throw new Error(
                    'Invalid custom recipient address: "' + e.message + '".'
                );
            }

            if (resolvedAddress) {
                effectiveRoyaltyRecipient = resolvedAddress;
            } else {
                throw new Error("Could not resolve ENS name.");
            }
        }
    } else {
        try {
            effectiveRoyaltyRecipient = await walletProvider
                .getSigner()
                .getAddress();
        } catch (e) {
            throw new Error(
                'Could not retrieve wallet address: "' + e.message + '".'
            );
        }
    }

    if (dataType === "image") {
        return await mintImageNft(
            {
                title,
                description,
                editionSize,
                image,
                effectiveRoyaltyPercentage,
                effectiveRoyaltyRecipient,
            },
            walletProvider,
            handleTransaction
        );
    } else {
        return await mintTextNft(
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
            handleTransaction
        );
    }
}

export { mintNft, estimateTextMintFee };
