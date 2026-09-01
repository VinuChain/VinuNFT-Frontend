import { ethers } from "ethers";
import { BRIDGE_EVM_CHAINS } from "./wanbridge";

// Derived, not copied. Two hardcoded lists is how the live catalog's XPL
// (Plasma, chain 9745) ended up EVM in fact and unknown in code.
const EVM_WANBRIDGE_CHAIN_TYPES = BRIDGE_EVM_CHAINS.map(
    (chain) => chain.chainType
);

// A Map, not an object literal: `toChain` is caller-supplied and "constructor"
// must not resolve to something truthy.
const NON_EVM_DESTINATION_PATTERNS = new Map([
    ["BTC", /^[13bc][A-Za-z0-9]{25,90}$/],
    ["SOL", /^[1-9A-HJ-NP-Za-km-z]{32,44}$/],
    ["TRX", /^T[1-9A-HJ-NP-Za-km-z]{25,40}$/],
]);

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

// True when this app knows the account format for a chain at all. The page uses
// it to route an unknown destination chain to the official WanBridge app rather
// than offering a submit button that cannot be honoured.
export function canValidateDestinationChain(chainType) {
    return (
        isEvmWanBridgeChain(chainType) ||
        NON_EVM_DESTINATION_PATTERNS.has(chainType)
    );
}

export function isDestinationAccount(value, toChain) {
    if (!value || !toChain) {
        return false;
    }
    if (isEvmWanBridgeChain(toChain)) {
        return ethers.utils.isAddress(value);
    }

    // Fail closed. The old catch-all `/^[A-Za-z0-9:_.-]{8,128}$/` accepted a
    // truncated EVM address and the literal string "not-an-address" for any
    // chain neither list knew — on a hand-typed destination for a transfer
    // nobody can reverse. Both the page and the create-tx proxy call this.
    const pattern = NON_EVM_DESTINATION_PATTERNS.get(toChain);
    return pattern ? pattern.test(value) : false;
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
