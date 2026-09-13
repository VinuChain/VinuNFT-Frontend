import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

const mod = await import("../src/common/walletSubscription.js");
const { replaceWalletSubscription, resetWalletSubscription } = mod.default || mod;

/** A provider with the public listener API and NO private _events map. */
function publicApiProvider() {
    const listeners = new Map();
    return {
        on(event, fn) {
            listeners.set(event, [...(listeners.get(event) || []), fn]);
        },
        removeListener(event, fn) {
            listeners.set(event, (listeners.get(event) || []).filter((f) => f !== fn));
        },
        emit(event, ...args) {
            for (const fn of listeners.get(event) || []) fn(...args);
        },
        count(event) {
            return (listeners.get(event) || []).length;
        },
    };
}

const handlersFor = (log, tag) => [
    ["accountsChanged", () => log.push(`${tag}:accounts`)],
    ["chainChanged", () => log.push(`${tag}:chain`)],
    ["disconnect", () => log.push(`${tag}:disconnect`)],
];

beforeEach(() => resetWalletSubscription());

test("reconnecting the same provider keeps exactly one handler per event", () => {
    // The Codex-reported bug: "Change Wallet" to SafePal twice left two copies
    // of every handler, because the old cleanup needed _events.
    const sp = publicApiProvider();
    const log = [];
    replaceWalletSubscription(sp, handlersFor(log, "first"));
    replaceWalletSubscription(sp, handlersFor(log, "second"));
    assert.equal(sp.count("accountsChanged"), 1);
    assert.equal(sp.count("chainChanged"), 1);
    sp.emit("chainChanged", "0xcf");
    assert.deepEqual(log, ["second:chain"], "the stale first handler must not fire");
});

test("switching away detaches the previous wallet so it cannot drive the page", () => {
    const sp = publicApiProvider();
    const mm = publicApiProvider();
    const log = [];
    replaceWalletSubscription(sp, handlersFor(log, "safepal"));
    replaceWalletSubscription(mm, handlersFor(log, "metamask"));
    sp.emit("disconnect");
    sp.emit("accountsChanged", []);
    assert.deepEqual(log, [], "the wallet the user left must not disconnect the current one");
    mm.emit("accountsChanged", ["0xabc"]);
    assert.deepEqual(log, ["metamask:accounts"]);
});

test("tolerates a previous provider with no removeListener", () => {
    const bare = { on() {} };
    const mm = publicApiProvider();
    replaceWalletSubscription(bare, handlersFor([], "bare"));
    assert.doesNotThrow(() => replaceWalletSubscription(mm, handlersFor([], "mm")));
    assert.equal(mm.count("accountsChanged"), 1);
});
