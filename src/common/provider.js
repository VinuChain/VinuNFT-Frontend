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

const restoreDefaultReadProvider = () => {
    _readProvider = defaultReadProvider;
    for (const listener of Array.from(_readListeners)) {
        listener();
    }
};

const ensProvider = new ethers.providers.AlchemyProvider(
    config.networks.ens.chainId,
    config.api_keys.alchemy_mainnet
);

export {
    defaultReadProvider,
    ensProvider,
    restoreDefaultReadProvider,
    useReadProvider,
    useWalletProvider,
};
