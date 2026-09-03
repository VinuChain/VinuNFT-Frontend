import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const net = await import("../src/common/network.js");
const { switchToVinuChain } = net.default || net;
const cfg = await import("../src/config.js");
const config = cfg.default || cfg;

const CHAIN_HEX = `0x${config.networks.main.chainId.toString(16)}`;

function wallet(handler) {
    const calls = [];
    return {
        calls,
        request: async (payload) => {
            calls.push(payload);
            return handler(payload);
        },
    };
}
const rejectWith = (code) => {
    const error = new Error("wallet said no");
    error.code = code;
    return error;
};

test("the chain id sent is VinuChain's, hex encoded", () => {
    assert.equal(CHAIN_HEX, "0xcf");
    assert.equal(parseInt(CHAIN_HEX, 16), 207);
});

test("a wallet that already knows the chain is only asked to switch", async () => {
    const w = wallet(() => null);
    assert.equal(await switchToVinuChain(w), true);
    assert.deepEqual(w.calls.map((c) => c.method), ["wallet_switchEthereumChain"]);
    assert.deepEqual(w.calls[0].params, [{ chainId: CHAIN_HEX }]);
});

test("an unknown chain (4902) is added with parameters taken from config", async () => {
    // VinuChain is not preconfigured in MetaMask, so a first-time visitor has
    // nothing to switch to and must be offered the network itself.
    const w = wallet((p) => {
        if (p.method === "wallet_switchEthereumChain") throw rejectWith(4902);
        return null;
    });

    assert.equal(await switchToVinuChain(w), true);
    assert.deepEqual(w.calls.map((c) => c.method), [
        "wallet_switchEthereumChain",
        "wallet_addEthereumChain",
    ]);

    const added = w.calls[1].params[0];
    assert.equal(added.chainId, CHAIN_HEX);
    assert.equal(added.chainName, config.networks.main.name);
    assert.deepEqual(added.nativeCurrency, config.nativeCurrency);
    assert.deepEqual(added.rpcUrls, [config.rpc]);
    assert.deepEqual(added.blockExplorerUrls, [config.blockExplorer.url]);
});

test("a user declining the switch is not re-prompted to add the chain", async () => {
    // 4001 is a refusal, not an unknown chain. Falling through to an add would
    // ask the same question twice.
    const w = wallet(() => {
        throw rejectWith(4001);
    });
    assert.equal(await switchToVinuChain(w), false);
    assert.deepEqual(w.calls.map((c) => c.method), ["wallet_switchEthereumChain"]);
});

test("a user declining the add reports failure rather than throwing", async () => {
    const w = wallet((p) => {
        throw rejectWith(p.method === "wallet_switchEthereumChain" ? 4902 : 4001);
    });
    assert.equal(await switchToVinuChain(w), false);
});

test("no wallet present is a false, not a crash", async () => {
    for (const value of [undefined, null, {}]) {
        assert.equal(await switchToVinuChain(value), false);
    }
});

test("the added network matches the app's own chain configuration", () => {
    // If these drifted, the button would add a network the app cannot talk to.
    assert.equal(config.networks.main.chainId, 207);
    assert.equal(config.nativeCurrency.symbol, "VC");
    assert.equal(config.nativeCurrency.decimals, 18);
    assert.match(config.rpc, /^https:\/\//);
    assert.match(config.blockExplorer.url, /^https:\/\//);
});

test("the wrong-network button switches the wallet that is actually connected", () => {
    // WalletButton connects through Web3Modal, which also serves non-injected
    // wallets such as Frame. `window.ethereum` is then absent, or it is a
    // DIFFERENT wallet: the button either did nothing or switched an unrelated
    // wallet while the connected one stayed on the wrong chain. The bridge flow
    // already passes `walletProvider.provider`; this is the same seam.
    const source = readFileSync("src/components/Header.js", "utf8");
    assert.match(source, /switchToVinuChain\(walletProvider\?\.provider\)/);
    assert.equal(
        source.includes("window.ethereum"),
        false,
        "the injected provider is not necessarily the connected one"
    );
});
