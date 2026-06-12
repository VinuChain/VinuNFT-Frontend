import React from "react";
import { ethers } from "ethers";
import Web3Modal from "web3modal";
import {
    restoreDefaultReadProvider,
    useReadProvider,
    useWalletProvider,
} from "../common/provider";
import config from "../config";
import ethProvider from "eth-provider";
import { atom, useRecoilState } from "recoil";
import { formatError, standardErrorState } from "../common/error";

const chainIdState = atom({
    key: "chainId",
    default: null,
});

export default function WalletButton() {
    const [, setReadProvider] = useReadProvider();
    const [walletProvider, setWalletProvider] = useWalletProvider();
    const [, setStandardError] = useRecoilState(standardErrorState);
    const [, setChainId] = useRecoilState(chainIdState);

    const providerOptions = {
        frame: {
            package: ethProvider,
        },
    };

    const connectWallet = async () => {
        const web3Modal = new Web3Modal({
            network: config.networks.main.chainId,
            cacheProvider: false,
            providerOptions,
            disableInjectedProvider: false,
        });
        // Force to prompt wallet selection
        web3Modal.clearCachedProvider();

        let wallet;

        try {
            wallet = await web3Modal.connect();
        } catch (e) {
            if (e?.message) {
                setStandardError(formatError(e));
            } else {
                // Some wallets reject the promise without actually throwing an error.
                // In this situation we fail silently.
                console.log(e);
            }
            return;
        }

        setStandardError(null);

        // Remove any pre-existing event handlers
        delete wallet._events.accountsChanged;
        delete wallet._events.chainChanged;
        delete wallet._events.disconnect;
        delete wallet._events.network;

        // The only remaining one is the default connect eventHandler
        wallet._eventsCount = 1;

        const handleDisconnect = () => {
            setWalletProvider(null);
            restoreDefaultReadProvider();
        };

        const handleChange = async () => {
            if (wallet.selectedAddress) {
                const regeneratedProvider = new ethers.providers.Web3Provider(
                    wallet
                );
                setReadProvider(regeneratedProvider);
                setWalletProvider(regeneratedProvider);
            } else {
                // If the provider is connected but no addresses are selected, treat it as a disconnection
                handleDisconnect();
            }
        };

        wallet.on("disconnect", handleDisconnect);
        wallet.on("accountsChanged", handleChange);
        wallet.on("chainChanged", handleChange);

        // ethers.js recommends refreshing the page when a user changes network
        wallet.on("network", (newNetwork, oldNetwork) => {
            // When a Provider makes its initial connection, it emits a "network"
            // event with a null oldNetwork along with the newNetwork. So, if the
            // oldNetwork exists, it represents a changing network
            if (oldNetwork) {
                window.location.reload();
            }
        });

        const newProvider = new ethers.providers.Web3Provider(wallet);
        setReadProvider(newProvider);
        setWalletProvider(newProvider);
        const network = await newProvider.getNetwork();
        setChainId(network?.chainId);
    };

    return (
        <div className="vinunft-wallet">
            <button
                type="button"
                className="vinunft-wallet__button"
                onClick={connectWallet}
            >
                <span
                    className={
                        "vinunft-wallet__status" +
                        (walletProvider ? " is-connected" : "")
                    }
                    aria-hidden="true"
                ></span>
                <span>
                    {walletProvider ? "Change Wallet" : "Connect Wallet"}
                </span>
            </button>
        </div>
    );
}
