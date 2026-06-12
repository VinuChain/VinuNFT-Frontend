import { ethers } from "ethers";

const EVM_WANBRIDGE_CHAIN_TYPES = [
    "ARETH",
    "AVAX",
    "BASEETH",
    "BNB",
    "ETH",
    "MATIC",
    "OETH",
    "VC",
    "WAN",
];

export function isChainType(value) {
    return Boolean(value && /^[A-Z0-9]{2,16}$/.test(value));
}

export function isPositiveDecimal(value) {
    return Boolean(
        value && /^(?:\d+|\d*\.\d+)$/.test(value) && Number(value) > 0
    );
}

export function isEvmWanBridgeChain(chainType) {
    return Boolean(chainType && EVM_WANBRIDGE_CHAIN_TYPES.includes(chainType));
}

export function isDestinationAccount(value, toChain) {
    if (!value || !toChain) {
        return false;
    }
    if (isEvmWanBridgeChain(toChain)) {
        return ethers.utils.isAddress(value);
    }
    if (toChain === "BTC") {
        return /^[13bc][A-Za-z0-9]{25,90}$/.test(value);
    }
    if (toChain === "SOL") {
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
    }
    if (toChain === "TRX") {
        return /^T[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(value);
    }

    return /^[A-Za-z0-9:_.-]{8,128}$/.test(value);
}

export function isTokenIdentifier(value, chainType) {
    if (!value || !chainType) {
        return false;
    }
    if (isEvmWanBridgeChain(chainType)) {
        return ethers.utils.isAddress(value);
    }

    return /^[A-Za-z0-9:_.-]{1,128}$/.test(value);
}
