import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const cfg = await import("../src/config.js");
const config = cfg.default || cfg;

/**
 * VinuChain identifiers are ecosystem-wide: chain id, RPC, explorer, native
 * currency and token metadata must match the wider VinuChain projects and the
 * chain itself. These pin the values; scripts/verify-deployed-truth.mjs checks
 * the contract side against the live chain.
 */

test("chain identity matches VinuChain mainnet", () => {
    assert.equal(config.networks.main.chainId, 207);
    assert.equal(config.rpc, "https://rpc.vinuchain.org");
});

test("the testnet is recorded, and recorded as unusable by this app", () => {
    // Measured 2026-09-02: eth_chainId returns 0xce and testnet.vinuexplorer.org
    // answers. The ledger's "no reachable VinuChain testnet" blocker is void.
    assert.equal(config.networks.testnet.chainId, 206);
    assert.equal(config.networks.testnet.rpc, "https://vinufoundation-rpc.com");

    // Reachable is not the same as usable. Nothing is deployed on 206, so the
    // app has no addresses and no first blocks for it, and the CSP does not
    // allow its RPC. These assertions fail the moment someone adds a testnet
    // entry to the UI without doing the deployment first — which would give
    // users a network switch that renders an empty marketplace and blames the
    // chain.
    assert.equal(Object.keys(config.contractAddresses).join(), "v1");
    assert.ok(
        !readFileSync("add_csp.js", "utf8").includes(
            new URL(config.networks.testnet.rpc).origin
        ),
        "the testnet RPC is in connect-src, so this is no longer a recorded coordinate — deploy to 206 and register its addresses"
    );
});

test("native currency is VC, the protocol-native monetary unit", () => {
    assert.equal(config.nativeCurrency.symbol, "VC");
    assert.equal(config.nativeCurrency.name, "VinuCoin");
    assert.equal(config.nativeCurrency.decimals, 18);
});

test("the block explorer is VinuExplorer on its canonical host", () => {
    assert.equal(config.blockExplorer.name, "VinuExplorer");
    // The apex domain 301s to mainnet.*, so linking it added a redirect to
    // every explorer link the app emits.
    assert.equal(config.blockExplorer.url, "https://mainnet.vinuexplorer.org");
});

test("token registry decimals and symbols match what the chain reports", () => {
    // Confirmed by read-only calls against chain 207: decimals() and symbol()
    // on each address returned exactly these values.
    const expected = {
        wvc: { decimals: 18, symbol: "WVC" },
        usdt: { decimals: 6, symbol: "USDT" },
        vinu: { decimals: 18, symbol: "VINU" },
        eth: { decimals: 18, symbol: "ETH" },
    };
    assert.deepEqual(Object.keys(config.tokens).sort(), Object.keys(expected).sort());
    for (const [id, want] of Object.entries(expected)) {
        assert.equal(config.tokens[id].decimals, want.decimals, `${id} decimals`);
        assert.equal(config.tokens[id].symbol, want.symbol, `${id} symbol`);
        assert.match(config.tokens[id].address, /^0x[a-fA-F0-9]{40}$/, `${id} address`);
    }
});

function sourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (full.endsWith(".js") && !full.endsWith("config.js")) out.push(full);
    }
    return out;
}

test("no source file hard-codes an ecosystem identifier outside the registry", () => {
    // One registry is the point: a hard-coded copy is what let the footer link a
    // different explorer host from every other link in the app.
    const offenders = [];
    for (const file of sourceFiles("src")) {
        const text = readFileSync(file, "utf8");
        for (const pattern of [
            /vinuexplorer\.org/,
            /rpc\.vinuchain\.org/,
            /chainId:\s*207\b/,
        ]) {
            if (pattern.test(text)) offenders.push(`${file} contains ${pattern}`);
        }
    }
    assert.deepEqual(offenders, [], "ecosystem identifiers must come from src/config.js");
});

test("the deployed-truth gate covers every contract in the registry", () => {
    const gate = readFileSync("scripts/verify-deployed-truth.mjs", "utf8");
    for (const name of Object.keys(config.contractAddresses.v1)) {
        assert.ok(gate.includes(name), `${name} must be checked against the chain`);
    }
});

test("the CSP allows the RPC and explorer the registry names", () => {
    const csp = readFileSync("add_csp.js", "utf8");
    assert.ok(csp.includes(new URL(config.rpc).origin), "connect-src must allow the RPC");
});
