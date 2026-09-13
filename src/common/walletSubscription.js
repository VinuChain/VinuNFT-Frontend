/**
 * Swap which wallet the page is listening to.
 *
 * WalletButton used to clean up the previous connection by deleting entries
 * from the provider's private `_events` map. That only works on
 * EventEmitter-backed providers. A provider without `_events` — SafePal
 * connected through its own namespace — kept every handler, so each
 * "Change Wallet" added another copy: stale `handleChange` callbacks kept
 * firing, and a wallet the user had switched away from could still replace or
 * disconnect the current one.
 *
 * Detaching through the public listener API works for every provider.
 */

let current = null;

/**
 * Remove the handlers attached on the last connect, then attach `handlers`
 * (an array of [event, handler] pairs) to `wallet` and remember them.
 */
export function replaceWalletSubscription(wallet, handlers) {
    if (current) {
        const { wallet: previous, handlers: previousHandlers } = current;
        if (typeof previous.removeListener === "function") {
            for (const [event, handler] of previousHandlers) {
                previous.removeListener(event, handler);
            }
        }
    }
    for (const [event, handler] of handlers) {
        wallet.on(event, handler);
    }
    current = { wallet, handlers };
}

/** Test seam: forget the remembered subscription. */
export function resetWalletSubscription() {
    current = null;
}
