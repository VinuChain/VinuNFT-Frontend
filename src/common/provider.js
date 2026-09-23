import { useState, useEffect } from "react";
import { ethers } from "ethers";
import config from "../config";

var defaultReadProvider = new ethers.providers.JsonRpcProvider(config.rpc);

var _readProvider = defaultReadProvider;
var _walletProvider = null;
var _readListeners = new Set();
var _writeListeners = new Set();

const _useForceUpdate = (listeners) => {
    const [, updateState] = useState();
    useEffect(() => {
        const forceUpdate = () => updateState({});
        listeners.add(forceUpdate);
        return () => listeners.delete(forceUpdate);
    });

    return () => {
        for (const listener of Array.from(listeners)) {
            listener();
        }
    };
};

const useReadProvider = () => {
    const update = _useForceUpdate(_readListeners);
    const setReadProvider = (newProvider) => {
        _readProvider = newProvider;
        update();
    };
    return [_readProvider, setReadProvider];
};

const useWalletProvider = () => {
    const update = _useForceUpdate(_writeListeners);

    const setWalletProvider = (newProvider) => {
        _walletProvider = newProvider;
        update();
    };

    return [_walletProvider, setWalletProvider];
};

// The wallet provider as of now, for async work that must not apply its result
// after the wallet has changed or gone while it was waiting.
const currentWalletProvider = () => _walletProvider;

const restoreDefaultReadProvider = () => {
    _readProvider = defaultReadProvider;
    for (const listener of Array.from(_readListeners)) {
        listener();
    }
};

// Not ethers 5's AlchemyProvider: it still targets eth-mainnet.alchemyapi.io,
// which no longer resolves, so every ENS lookup failed. Without a key, the
// keyless public mainnet RPC the CSP already allows.
const ensProvider = new ethers.providers.StaticJsonRpcProvider(
    config.api_keys.alchemy_mainnet
        ? `https://eth-mainnet.g.alchemy.com/v2/${config.api_keys.alchemy_mainnet}`
        : "https://ethereum-rpc.publicnode.com",
    config.networks.ens.chainId
);

export {
    currentWalletProvider,
    defaultReadProvider,
    ensProvider,
    restoreDefaultReadProvider,
    useReadProvider,
    useWalletProvider,
};
