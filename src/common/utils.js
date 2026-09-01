import { ethers } from "ethers";
import config from "../config";

const getWalletAddress = async (provider) => {
    const signer = provider?.getSigner();
    if (signer) {
        return await signer.getAddress();
    } else {
        return null;
    }
};

const shortenAddress = (address, nChar) => {
    return (
        address.substring(0, nChar + 2) +
        "..." +
        address.substring(address.length - nChar)
    );
};

function parseTokenAmount(amount, tokenId) {
    const token = config.tokens[tokenId];

    if (token === undefined) {
        throw new Error(`Token ${tokenId} not found in config.`);
    }

    return ethers.utils.parseUnits(amount, token.decimals);
}

/**
 * Does this typed amount carry more decimal places than the token can hold?
 *
 * parseUnits throws "fractional component exceeds decimals" for such a value,
 * and that happens deep inside a transaction where the user only sees an
 * ethers internal message. Callers use this to refuse the value up front.
 */
function exceedsTokenDecimals(amount, tokenId) {
    const token = config.tokens[tokenId];

    if (token === undefined) {
        return false;
    }

    const [, fraction = ""] = String(amount).split(".");
    return fraction.length > token.decimals;
}

/**
 * Network fee for a contract call, as a decimal string in the native currency.
 *
 * null whenever the node will not quote one: a failed estimate is not a fee of
 * zero, and someone shown "0" would be told the transaction is free.
 */
async function estimateFee(estimateCall, provider) {
    try {
        const [gas, gasPrice] = await Promise.all([
            estimateCall(),
            provider.getGasPrice(),
        ]);

        return ethers.utils.formatUnits(
            gas.mul(gasPrice),
            config.nativeCurrency.decimals
        );
    } catch {
        return null;
    }
}

function formatTokenAmount(amount, tokenId) {
    const token = config.tokens[tokenId];

    if (token === undefined) {
        throw new Error(`Token ${tokenId} not found in config.`);
    }

    return ethers.utils.formatUnits(amount, token.decimals);
}

export {
    getWalletAddress,
    shortenAddress,
    parseTokenAmount,
    formatTokenAmount,
    exceedsTokenDecimals,
    estimateFee,
};
