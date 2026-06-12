import { ethers } from "ethers";
import config from "../config";
import { v1 } from "./abi";

export const ADDRESS_PROFILE_WINDOW = 12;

function recentTokenIds(lastTokenId, windowSize) {
    const ids = [];
    for (let offset = 0; offset < windowSize; offset++) {
        const tokenId = lastTokenId - offset;
        if (tokenId >= 1) {
            ids.push(tokenId);
        }
    }
    return ids;
}

export async function loadAddressProfileNfts(
    readProvider,
    address,
    options = {}
) {
    if (!ethers.utils.isAddress(address)) {
        throw new Error("Invalid address");
    }

    const normalizedAddress = ethers.utils.getAddress(address);
    const windowSize = options.windowSize || ADDRESS_PROFILE_WINDOW;
    const owned = [];
    const created = [];

    for (const nftType of ["text", "image"]) {
        const contract = new ethers.Contract(
            config.contractAddresses.v1[nftType],
            v1[nftType],
            readProvider
        );
        const lastTokenId = (await contract.lastTokenId()).toNumber();

        for (const tokenId of recentTokenIds(lastTokenId, windowSize)) {
            const [balance, author] = await Promise.all([
                contract
                    .balanceOf(normalizedAddress, tokenId)
                    .then((value) => value.toNumber())
                    .catch(() => 0),
                contract.authorOf(tokenId).catch(() => null),
            ]);

            if (balance > 0) {
                owned.push({ type: nftType, id: tokenId, balance });
            }

            if (
                author &&
                ethers.utils.getAddress(author) === normalizedAddress
            ) {
                created.push({ type: nftType, id: tokenId });
            }
        }
    }

    return { owned, created };
}
