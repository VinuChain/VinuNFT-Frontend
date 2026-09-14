import React from "react";
import { ethers } from "ethers";
import Web3Modal from "web3modal";
import {
    currentWalletProvider,
    restoreDefaultReadProvider,
    useReadProvider,
    useWalletProvider,
} from "../common/provider";
import config from "../config";
import ethProvider from "eth-provider";
import { atom, useRecoilState } from "recoil";
import { formatError, standardErrorState } from "../common/error";
import { safePalProviderOptions } from "../common/safepal";
import { replaceWalletSubscription } from "../common/walletSubscription";
import { isSameWallet, requestAccountPicker } from "../common/accountPicker";

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

    /**
     * Read through the wallet only while it is on VinuChain; otherwise keep the
     * configured RPC and return the chain it is actually on.
     *
     * Web3Modal connects a wallet on whatever chain it happens to be, and the
     * read path is a whole-history fold cached per contract address and block
     * height. Pointed at another chain it continues a VinuChain fold up to a
     * foreign head, and the mixed events and impossible `lastIndexedBlock`
     * survive the disconnect. Writes still go to the wallet, which is what the
     * wrong-network banner is about.
     *
     * The lookup is skipped once `provider` is no longer the wallet provider:
     * a disconnect or a newer event landing while it waited has already set
     * the page up, and applying this result would undo that.
     */
    const readThrough = async (provider) => {
        const network = await provider.getNetwork();
        if (currentWalletProvider() !== provider) return;
        if (network?.chainId === config.networks.main.chainId) {
            setReadProvider(provider);
        } else {
            restoreDefaultReadProvider();
        }
        setChainId(network?.chainId);
    };

    const connectWallet = async () => {
        // The wallet the page is using now, if any. Picking it again below is a
        // request for a different account of it.
        const previousWallet = walletProvider?.provider;

        // Web3Modal v1 appends a new #WEB3_CONNECT_MODAL_ID container every time
        // it is constructed but renders into the first one in the document, so
        // each click left one more empty container behind. Remove the previous
        // picker so this one renders into a container of its own.
        document
            .querySelectorAll("#WEB3_CONNECT_MODAL_ID")
            .forEach((container) => container.remove());

        const web3Modal = new Web3Modal({
            network: config.networks.main.chainId,
            cacheProvider: false,
            // SafePal is added per click: it is often only on
            // window.safepalProvider, which Web3Modal's injected entry never
            // reads. See common/safepal.js.
            providerOptions: {
                ...providerOptions,
                ...safePalProviderOptions(),
            },
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
        // Only EventEmitter-backed providers expose _events. A wallet connected
        // through its own namespace (SafePal) need not, and an unguarded
        // delete there throws and aborts the connection it just approved.
        if (wallet._events) {
            delete wallet._events.accountsChanged;
            delete wallet._events.chainChanged;
            delete wallet._events.disconnect;
            delete wallet._events.network;

            // The only remaining one is the default connect eventHandler
            wallet._eventsCount = 1;
        }

        const handleDisconnect = () => {
            setWalletProvider(null);
            restoreDefaultReadProvider();
        };

        /**
         * Follow the account the wallet reports. EIP-1193 passes the new
         * account list with the event, and an empty list means the wallet
         * locked or dropped this site. This used to read wallet.selectedAddress,
         * a deprecated MetaMask property other wallets (SafePal among them)
         * never set, which turned every account switch in those wallets into a
         * disconnect.
         */
        const handleAccountsChanged = async (accounts) => {
            // Accounts are read through ethers, not wallet.request: Web3Modal
            // still hands back legacy send/sendAsync providers that have none.
            const regeneratedProvider = new ethers.providers.Web3Provider(
                wallet
            );
            const current = Array.isArray(accounts)
                ? accounts
                : await regeneratedProvider.listAccounts().catch(() => []);
            if (current.length > 0) {
                setWalletProvider(regeneratedProvider);
                await readThrough(regeneratedProvider);
            } else {
                handleDisconnect();
            }
        };

        // A chain change passes a chain id, not accounts, so it gets its own
        // handler: it used to share the account one and disconnect whenever
        // selectedAddress was missing. The chain id is refreshed too, so the
        // wrong-network alert follows the wallet.
        const handleChainChanged = async () => {
            const regeneratedProvider = new ethers.providers.Web3Provider(
                wallet
            );
            setWalletProvider(regeneratedProvider);
            await readThrough(regeneratedProvider);
        };

        // ethers.js recommends refreshing the page when a user changes network
        const handleNetwork = (newNetwork, oldNetwork) => {
            // When a Provider makes its initial connection, it emits a "network"
            // event with a null oldNetwork along with the newNetwork. So, if the
            // oldNetwork exists, it represents a changing network
            if (oldNetwork) {
                window.location.reload();
            }
        };

        // Detaches the previous connection's handlers through the public
        // listener API first — the _events wipe above cannot reach a provider
        // that has no _events. See common/walletSubscription.js.
        replaceWalletSubscription(wallet, [
            ["disconnect", handleDisconnect],
            ["accountsChanged", handleAccountsChanged],
            ["chainChanged", handleChainChanged],
            ["network", handleNetwork],
        ]);

        // Web3Modal hands back the same wallet without asking it anything the
        // user can see, so re-picking it would change nothing. Ask it for its
        // account picker; see common/accountPicker.js. A different wallet has
        // just been through its own connection prompt instead.
        const newProvider = new ethers.providers.Web3Provider(wallet);
        if (isSameWallet(wallet, previousWallet)) {
            await requestAccountPicker(wallet);
            // The picker can also end the connection: the user may remove this
            // site's access or lock the wallet from it, and the handlers above
            // have then already cleared the page. Re-read the accounts instead
            // of restoring a connection that no longer exists.
            const accounts = await newProvider.listAccounts().catch(() => []);
            if (accounts.length === 0) {
                handleDisconnect();
                return;
            }
        }

        setWalletProvider(newProvider);
        await readThrough(newProvider);
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
