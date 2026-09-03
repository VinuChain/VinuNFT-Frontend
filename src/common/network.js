import config from "../config";

/**
 * Ask the wallet to switch to VinuChain, adding it first if the wallet has
 * never heard of it.
 *
 * VinuChain is not preconfigured in MetaMask, so a first-time visitor has no
 * network to switch *to*. Telling them "please switch" without offering to add
 * it is a dead end, which is what the wrong-network alert used to be.
 *
 * Returns true when the wallet reports success. A user declining the prompt is
 * a normal outcome and resolves false rather than throwing.
 */
export async function switchToVinuChain(ethereum) {
    if (!ethereum?.request) {
        return false;
    }

    const chainIdHex = `0x${config.networks.main.chainId.toString(16)}`;

    try {
        await ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: chainIdHex }],
        });
        return true;
    } catch (error) {
        // 4902: the wallet does not know this chain yet. Anything else is a
        // refusal or a wallet that cannot switch, and must not be retried as an
        // add — that would prompt the user twice for the same decision.
        if (error?.code !== 4902) {
            return false;
        }
    }

    try {
        await ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
                {
                    chainId: chainIdHex,
                    chainName: config.networks.main.name,
                    nativeCurrency: config.nativeCurrency,
                    rpcUrls: [config.rpc],
                    blockExplorerUrls: [config.blockExplorer.url],
                },
            ],
        });
        return true;
    } catch {
        return false;
    }
}
