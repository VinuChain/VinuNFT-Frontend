import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("../src/common/safepal.js");
const { findSafePalProvider, safePalProviderOptions } = mod.default || mod;

const provider = (flags = {}) => {
    const calls = [];
    return {
        ...flags,
        calls,
        request: async ({ method }) => {
            calls.push(method);
            return method === "eth_requestAccounts" ? ["0xabc"] : null;
        },
    };
};

// Each shape was reproduced on production as a modal offering only Frame.
test("finds SafePal on its own namespace with window.ethereum absent", () => {
    const sp = provider({ isSafePal: true });
    assert.equal(findSafePalProvider({ safepalProvider: sp }), sp);
});

test("finds the namespace provider, not MetaMask, when MetaMask owns window.ethereum", () => {
    const sp = provider({ isSafePal: true });
    const mm = provider({ isMetaMask: true });
    assert.equal(findSafePalProvider({ ethereum: mm, safepalProvider: sp }), sp);
});

test("finds SafePal inside a multi-extension providers array", () => {
    const sp = provider({ isSafePal: true });
    const mm = provider({ isMetaMask: true });
    assert.equal(findSafePalProvider({ ethereum: { providers: [mm, sp] } }), sp);
});

test("finds SafePal's in-app browser on window.ethereum", () => {
    const sp = provider({ isSafePal: true });
    assert.equal(findSafePalProvider({ ethereum: sp }), sp);
});

test("falls back to a flagged root when the providers array lacks SafePal", () => {
    const mm = provider({ isMetaMask: true });
    const root = { ...provider({ isSafePal: true }), providers: [mm] };
    assert.equal(findSafePalProvider({ ethereum: root }), root);
});

test("returns null when SafePal is not on the page", () => {
    assert.equal(findSafePalProvider(undefined), null);
    assert.equal(findSafePalProvider({}), null);
    assert.equal(
        findSafePalProvider({ ethereum: provider({ isMetaMask: true }) }),
        null
    );
});

test("offers no SafePal row when SafePal is absent", () => {
    // A row that cannot connect is worse than no row.
    assert.deepEqual(safePalProviderOptions({ ethereum: provider({ isMetaMask: true }) }), {});
    assert.deepEqual(safePalProviderOptions(undefined), {});
});

test("the SafePal row requests accounts from SafePal and hands back that provider", async () => {
    const sp = provider({ isSafePal: true });
    const mm = provider({ isMetaMask: true });
    const option = safePalProviderOptions({ ethereum: mm, safepalProvider: sp })["custom-safepal"];
    assert.equal(option.display.name, "SafePal");
    // Web3Modal v1's shouldDisplayProvider drops an entry with no truthy
    // package — the first build of this fix rendered no SafePal row for
    // exactly that reason while every other assertion here passed.
    assert.ok(option.package, "custom entries need a truthy package to render");
    assert.match(option.display.logo, /^data:image\/svg\+xml,/);
    const connected = await option.connector();
    assert.equal(connected, sp);
    assert.deepEqual(sp.calls, ["eth_requestAccounts"]);
    assert.deepEqual(mm.calls, [], "MetaMask must not be asked");
});

test("a rejected request surfaces as an error, not a silent connect", async () => {
    const sp = {
        isSafePal: true,
        request: async () => {
            throw Object.assign(new Error("User rejected"), { code: 4001 });
        },
    };
    const option = safePalProviderOptions({ safepalProvider: sp })["custom-safepal"];
    await assert.rejects(option.connector(), /User rejected/);
});
