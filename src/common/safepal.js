/**
 * SafePal for Web3Modal v1.
 *
 * Web3Modal v1's only injected entry reads `window.ethereum`, and SafePal is
 * often not there. Its extension installed but not set as the default wallet
 * leaves MetaMask on `window.ethereum` and SafePal only on
 * `window.safepalProvider` — reproduced on production as a modal offering
 * nothing but Frame. So SafePal gets its own `custom-safepal` entry, bound to
 * the SafePal provider wherever it was found.
 */

// SafePal's mark, as shipped by RainbowKit's safepalWallet (MIT).
export const SAFEPAL_ICON =
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2028%2028%22%3E%3Cpath%20fill%3D%22%234A21EF%22%20d%3D%22M0%200h28v28H0z%22%2F%3E%3Cg%20fill%3D%22%23F7F6FF%22%20clip-path%3D%22url(%23a)%22%3E%3Cpath%20d%3D%22M13.014%206c-.487%200-.954.193-1.298.538l-5.409%205.409a1.046%201.046%200%200%200%200%201.483l3.545%203.545V10.7c0-.468.377-.848.845-.848h7.451L22%206h-8.986ZM9.852%2018.148H17.3c.469%200%20.848-.38.848-.848v-6.275l3.545%203.545a1.046%201.046%200%200%201%200%201.483l-5.409%205.41a1.836%201.836%200%200%201-1.298.537H6l3.852-3.852Z%22%2F%3E%3C%2Fg%3E%3Cdefs%3E%3CclipPath%20id%3D%22a%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M6%206h16v16H6z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3C%2Fsvg%3E";

const isProvider = (value) =>
    Boolean(value) && typeof value.request === "function";

/**
 * The SafePal provider in any shape SafePal injects, or null. Mirrors
 * RainbowKit's safepalWallet detection: the namespace first, then the
 * multi-extension providers array, then a flagged window.ethereum.
 */
export function findSafePalProvider(win) {
    if (!win) return null;
    if (isProvider(win.safepalProvider)) return win.safepalProvider;
    const ethereum = win.ethereum;
    if (!ethereum) return null;
    if (Array.isArray(ethereum.providers)) {
        const hit = ethereum.providers.find((p) => p && p.isSafePal === true);
        return isProvider(hit) ? hit : null;
    }
    return ethereum.isSafePal === true && isProvider(ethereum)
        ? ethereum
        : null;
}

/**
 * Web3Modal providerOptions entry for SafePal, or {} when SafePal is absent so
 * the modal never shows a row that cannot connect. Read at click time, so a
 * wallet that injects after first paint is still found.
 */
export function safePalProviderOptions(
    win = typeof window !== "undefined" ? window : undefined
) {
    const provider = findSafePalProvider(win);
    if (!provider) return {};
    return {
        "custom-safepal": {
            // Web3Modal v1 hides any provider whose options carry no truthy
            // `package` (ProviderController.shouldDisplayProvider), custom
            // entries included — without this the row never renders. There is
            // no package to load: the connector already holds the provider.
            package: {},
            display: {
                logo: SAFEPAL_ICON,
                name: "SafePal",
                description: "Connect to your SafePal Wallet",
            },
            connector: async () => {
                await provider.request({ method: "eth_requestAccounts" });
                return provider;
            },
        },
    };
}
