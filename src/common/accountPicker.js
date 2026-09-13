/**
 * Let the user choose a different account of a wallet that is already
 * connected.
 *
 * Web3Modal v1's injected connector, and ours for SafePal, only call
 * eth_requestAccounts. A wallet that already trusts this site answers that
 * silently with the account it gave last time, so "Change Wallet" followed by
 * the same wallet could never change anything. Requesting the eth_accounts
 * permission (EIP-2255) is what makes MetaMask-family wallets show their
 * account picker again.
 *
 * Resolves, never rejects, with:
 * - "picked": the wallet answered; it reports any new account through
 *   accountsChanged.
 * - "declined": the user closed the picker (4001). Keep the current account.
 * - "unsupported": the wallet has no EIP-2255 (4200 / -32601, or no request
 *   method). It has no picker to offer; the user switches accounts in the
 *   wallet itself, which the page follows through accountsChanged.
 * - "failed": anything else, e.g. MetaMask's -32002 when a request is already
 *   open. The connection the user just approved is still valid, so this is
 *   reported, not thrown.
 */
const USER_REJECTED = 4001;
const UNSUPPORTED = new Set([4200, -32601]);

export async function requestAccountPicker(wallet) {
    if (!wallet || typeof wallet.request !== "function") return "unsupported";
    try {
        await wallet.request({
            method: "wallet_requestPermissions",
            params: [{ eth_accounts: {} }],
        });
        return "picked";
    } catch (error) {
        if (error?.code === USER_REJECTED) return "declined";
        if (UNSUPPORTED.has(error?.code)) return "unsupported";
        console.warn("Could not open the wallet's account picker:", error);
        return "failed";
    }
}
