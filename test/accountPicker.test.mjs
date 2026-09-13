import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("../src/common/accountPicker.js");
const { requestAccountPicker } = mod.default || mod;

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
