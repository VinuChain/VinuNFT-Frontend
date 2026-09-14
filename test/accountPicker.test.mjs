import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("../src/common/accountPicker.js");
const { requestAccountPicker, isSameWallet, pickerResultApplies } = mod.default || mod;

test("the same provider object is the same wallet", () => {
    const injected = { request() {} };
    assert.equal(isSameWallet(injected, injected), true);
});

test("two Frame wrappers are the same wallet, because Web3Modal rebuilds Frame on every pick", () => {
    // Comparing objects alone made re-picking Frame skip the account picker.
    assert.equal(isSameWallet({ isFrameNative: true }, { isFrameNative: true }), true);
});

test("different wallets, or no wallet before, are not the same wallet", () => {
    const metaMask = { isMetaMask: true };
    const safePal = { isSafePal: true };
    assert.equal(isSameWallet(safePal, metaMask), false);
    assert.equal(isSameWallet({ isFrameNative: true }, metaMask), false);
    assert.equal(isSameWallet(metaMask, undefined), false);
    assert.equal(isSameWallet(undefined, undefined), false);
});

test("a picker result applies to the session it was opened from, or this wallet's newer one", () => {
    const wallet = { request() {} };
    const session = { provider: wallet };
    assert.equal(pickerResultApplies(session, session, wallet), true);
    // An account switch made in the picker rebuilds the provider for the same wallet.
    assert.equal(pickerResultApplies({ provider: wallet }, session, wallet), true);
    // Frame: the session wraps the previous Frame wrapper, the picker the new one.
    const frameSession = { provider: { isFrameNative: true } };
    assert.equal(pickerResultApplies(frameSession, frameSession, { isFrameNative: true }), true);
});

test("a picker result does not apply after a disconnect or once another wallet took over", () => {
    // The picker can stay open while a newer Change Wallet connects a different
    // wallet; applying its result then put the older wallet back.
    const wallet = { request() {} };
    const session = { provider: wallet };
    assert.equal(pickerResultApplies(null, session, wallet), false);
    assert.equal(pickerResultApplies({ provider: { request() {} } }, session, wallet), false);
});

/** A wallet whose request() answers with `answer(args)` and records every call. */
function walletThat(answer) {
    const calls = [];
    return {
        calls,
        async request(args) {
            calls.push(args);
            return answer(args);
        },
    };
}

const failWith = (code) => () => {
    const error = new Error(`wallet error ${code}`);
    error.code = code;
    throw error;
};

test("asks for the eth_accounts permission, which is what opens the picker", async () => {
    // eth_requestAccounts is what "Change Wallet" used to re-send, and a wallet
    // that already trusts the site answers it without showing anything.
    const wallet = walletThat(() => [{ parentCapability: "eth_accounts" }]);
    assert.equal(await requestAccountPicker(wallet), "picked");
    assert.deepEqual(wallet.calls, [
        { method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] },
    ]);
});

test("closing the picker is a decline, not a failure", async () => {
    assert.equal(await requestAccountPicker(walletThat(failWith(4001))), "declined");
});

test("a wallet without EIP-2255 is unsupported, not declined", async () => {
    assert.equal(await requestAccountPicker(walletThat(failWith(4200))), "unsupported");
    assert.equal(await requestAccountPicker(walletThat(failWith(-32601))), "unsupported");
    assert.equal(await requestAccountPicker({}), "unsupported");
    assert.equal(await requestAccountPicker(null), "unsupported");
});

test("any other error is reported as failed and never rejects", async () => {
    // -32002: MetaMask already has a request open. The connection itself is
    // still good, so the caller must not be thrown out of it.
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(await requestAccountPicker(walletThat(failWith(-32002))), "failed");
        assert.equal(
            await requestAccountPicker(
                walletThat(() => {
                    throw new Error("no code at all");
                })
            ),
            "failed"
        );
    } finally {
        console.warn = warn;
    }
});
