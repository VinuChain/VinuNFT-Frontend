#!/usr/bin/env node
/**
 * Read-only production readiness against chain 207.
 *
 * VN-REL-001 asks whether the product's journeys work against the contracts
 * that are actually deployed. Most of that question is answerable today without
 * spending anything; the rest needs a funded key nobody here has. This reports
 * both, per journey, and — the part that makes it a gate rather than a
 * dashboard — it FAILS when what it observes disagrees with the expectations
 * committed below, in either direction.
 *
 * "In either direction" is deliberate. A journey recorded as needing a funded
 * key, which turns out to be exercisable, is drift too: it means someone put a
 * key in the environment and the honest write-up of this release is now wrong.
 *
 * Every status here is derived from a chain read or a source read. Nothing is
 * printed from a literal. Third-party hosts (WanBridge, IPFS gateways) get the
 * one exemption: a definite wrong answer fails, a transport error is a note,
 * because otherwise this gate goes red on somebody else's outage.
 *
 * Run: yarn verify:readiness   (needs network; ~1 minute, mostly the full
 * marketplace history scan that the discovery journey has to do to be honest.)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import * as configModule from "../src/config.js";
import * as abiModule from "../src/common/abi.js";
import * as nftInfoModule from "../src/common/nftInfo.js";
import * as wanbridgeModule from "../src/common/wanbridge.js";

// tsx CJS interop: named exports from src/ land on the .default namespace.
// The same shape the test suite uses (see test/wanbridge-amounts.test.mjs).
const config = configModule.default?.default ?? configModule.default;
const { v1: abis } = abiModule.default ?? abiModule;
const { fetchTokenMetadata } = nftInfoModule.default ?? nftInfoModule;
const { BRIDGE_EVM_CHAINS, WANBRIDGE_API_BASE, VINUCHAIN_CHAIN_TYPE, fetchWanBridgeJson, buildVinuChainRoutes } =
    wanbridgeModule.default ?? wanbridgeModule;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (path) => readFileSync(resolve(root, path), "utf8");

/**
 * The committed claim about this release. `reads` is what a visitor with no
 * wallet can do; `writes` is what sending a transaction would need.
 *
 *   ok          — proven by this run against chain 207
 *   blocked     — needs a funded chain-207 account; none is configured
 *   exercisable — a funded account IS configured, so the write half is testable
 *   n/a         — the journey has no write half
 *
 * Change a line here only with the evidence that justifies it.
 */
const EXPECTED = {
    creation: { reads: "ok", writes: "blocked" },
    ownership: { reads: "ok", writes: "blocked" },
    discovery: { reads: "ok", writes: "n/a" },
    commerce: { reads: "ok", writes: "blocked" },
    profiles: { reads: "ok", writes: "n/a" },
    activity: { reads: "ok", writes: "n/a" },
    bridge: { reads: "ok", writes: "blocked" },
    content: { reads: "ok", writes: "blocked" },
    recovery: { reads: "ok", writes: "n/a" },
};

const notes = [];
const provider = new ethers.providers.JsonRpcProvider(config.rpc, config.networks.main.chainId);
const at = (name) =>
    new ethers.Contract(config.contractAddresses.v1[name], abis[name], provider);

/**
 * Whether a transaction could actually be sent, derived rather than assumed:
 * a key in the environment with a non-zero balance on chain 207. With none,
 * every write path is blocked and this run may not claim otherwise.
 */
async function writeCapability() {
    const key = process.env.VINUNFT_READINESS_KEY || process.env.DEPLOYER_PRIVATE_KEY;
    if (!key || /^0x0+$/.test(key)) return "blocked";
    try {
        const address = new ethers.Wallet(key).address;
        const balance = await provider.getBalance(address);
        if (balance.isZero()) {
            notes.push(`a key for ${address} is configured but its balance is 0 ${config.nativeCurrency.symbol}`);
            return "blocked";
        }
        notes.push(`a funded key for ${address} is configured — write paths are exercisable`);
        return "exercisable";
    } catch {
        return "blocked";
    }
}

/** One full-history scan of a contract's logs, in the ranges the app uses. */
async function scanLogs(address, fromBlock, head) {
    const out = [];
    for (let from = fromBlock; from <= head; from += config.maxLogBlockRange) {
        const to = Math.min(from + config.maxLogBlockRange - 1, head);
        out.push(...(await provider.getLogs({ address, fromBlock: from, toBlock: to })));
    }
    return out;
}

const head = await provider.getBlockNumber();
const netChainId = Number((await provider.getNetwork()).chainId);
const writes = await writeCapability();

const text = at("text");
const image = at("image");
const marketplace = at("marketplace");
const marketplaceIface = new ethers.utils.Interface(abis.marketplace);
const textIface = new ethers.utils.Interface(abis.text);

// The full marketplace history, folded once and shared by discovery, commerce,
// profiles and activity — the same scan the app performs on a cold load.
const marketplaceLogs = await scanLogs(
    config.contractAddresses.v1.marketplace,
    Number(config.firstBlocks.v1.marketplace),
    head
);
const decodedMarketplace = marketplaceLogs.flatMap((log) => {
    try {
        return [marketplaceIface.parseLog(log)];
    } catch {
        return [];
    }
});

// The TextNFT's history, scanned the same way. A bounded window around the
// creation block is not enough: token 1 was minted far above it, which is
// exactly why the app scans everything and why this must too.
const textLogs = await scanLogs(
    config.contractAddresses.v1.text,
    Number(config.firstBlocks.v1.text),
    head
);
const decodedText = textLogs.flatMap((log) => {
    try {
        return [textIface.parseLog(log)];
    } catch {
        return [];
    }
});

const probes = {
    async creation() {
        if (netChainId !== config.networks.main.chainId) {
            throw new Error(`${config.rpc} reports chain ${netChainId}, config says ${config.networks.main.chainId}`);
        }
        const [textLast, imageLast, name, symbol] = await Promise.all([
            text.lastTokenId(),
            image.lastTokenId(),
            text.name(),
            text.symbol(),
        ]);
        if (textLast.isZero() || imageLast.isZero()) {
            throw new Error(`nothing has been minted: text lastTokenId=${textLast}, image lastTokenId=${imageLast}`);
        }
        // The constructor arguments the collection was actually deployed with.
        if (name !== "TextNFT" || symbol !== "VTXT") {
            throw new Error(`TextNFT identity changed: name=${name}, symbol=${symbol}`);
        }
        return `${textLast} text token(s), ${imageLast} image token(s) minted; TextNFT/${symbol}`;
    },

    async ownership() {
        const [author, supply, uri] = await Promise.all([
            text.authorOf(1),
            text.totalSupply(1),
            text.uri(1),
        ]);
        if (author === ethers.constants.AddressZero) throw new Error("authorOf(1) is the zero address");
        if (supply.isZero()) throw new Error("totalSupply(1) is 0");
        const balance = await text.balanceOf(author, 1);
        if (balance.isZero()) {
            notes.push("ownership: the author of text token 1 no longer holds any of it (transferred or burnt)");
        }
        if (!uri) throw new Error("uri(1) is empty");
        // Named overload: an ABI carrying a zero-argument totalSupply() would
        // make the bare call above ambiguous, which is the trap this release's
        // sync tooling exists to prevent.
        return `text#1 author ${author.slice(0, 10)}…, supply ${supply}, holder balance ${balance}`;
    },

    async discovery() {
        const listed = decodedMarketplace.filter((e) => /^Token(Listed|Sold|Delisted)$/.test(e.name));
        if (!listed.length) {
            throw new Error(
                `no marketplace events found between block ${config.firstBlocks.v1.marketplace} and ${head}`
            );
        }
        // Discovery is a full-history fold, not a bounded token-id window;
        // the absence assertion lives in test/audit-regressions.test.js.
        if (src("src/common/indexLoader.js").includes("MARKETPLACE_DISCOVERY_WINDOW")) {
            throw new Error("discovery is bounded by a token-id window again");
        }
        notes.push(
            "discovery: the index is folded per browser tab from chain logs. There is no shared " +
                "server-side index, so every cold load repeats this scan (VN-INDEX-001)."
        );
        return `${marketplaceLogs.length} marketplace log(s) over ${head - Number(config.firstBlocks.v1.marketplace)} blocks, ${listed.length} listing event(s)`;
    },

    async commerce() {
        const [paused, fee, commission, owner] = await Promise.all([
            marketplace.paused(),
            marketplace.platformFeePercentage(),
            marketplace.commissionAccount(),
            marketplace.owner(),
        ]);
        if (paused) throw new Error("the marketplace is paused — nothing can be listed or bought");
        if (fee.toString() !== "500") throw new Error(`platform fee is ${fee} bps, expected 500`);
        if (commission === ethers.constants.AddressZero) throw new Error("commissionAccount is the zero address");
        if (commission.toLowerCase() === owner.toLowerCase()) {
            notes.push(
                `commerce: commissionAccount == owner (${owner}), which the backend's AGENTS.md forbids. ` +
                    "Only an owner-only setCommissionAccount call can change it."
            );
        }
        const count = await marketplace.listingCount(config.contractAddresses.v1.text, 1);
        if (count.isZero()) {
            notes.push("commerce: text token 1 currently has no listings");
        } else {
            const listing = await marketplace.getListing(config.contractAddresses.v1.text, 1, 0);
            if (!listing || listing.length === 0) throw new Error("getListing returned nothing for a listing that exists");
        }
        return `unpaused, ${fee} bps to ${commission.slice(0, 10)}…, ${count} listing(s) on text#1`;
    },

    async profiles() {
        // A profile page is "everything this address did", derived from the
        // same logs the index folds. Proven by finding a real participant.
        const participants = new Set(
            decodedMarketplace
                .filter((e) => e.args?._seller || e.args?._buyer)
                .flatMap((e) => [e.args?._seller, e.args?._buyer].filter(Boolean))
                .map((a) => a.toLowerCase())
        );
        if (!participants.size) throw new Error("no marketplace participant addresses are derivable from chain logs");
        const [first] = [...participants];
        const balance = await text.balanceOf(first, 1);
        return `${participants.size} address(es) with marketplace history; balanceOf(${first.slice(0, 10)}…, text#1) = ${balance}`;
    },

    async activity() {
        const kinds = new Set(decodedMarketplace.map((e) => e.name));
        if (!kinds.size) throw new Error("no marketplace event decodes against the frontend ABI");
        const transfers = decodedText.filter((e) => e.name.startsWith("Transfer"));
        if (!transfers.length) {
            throw new Error(
                `no ERC-1155 transfer decodes from TextNFT between block ${config.firstBlocks.v1.text} and ${head}`
            );
        }
        const mints = transfers.filter((e) => e.args?.from === ethers.constants.AddressZero);
        if (!mints.length) throw new Error("no mint (transfer from the zero address) is visible in TextNFT history");
        return `${[...kinds].join(", ")} on the marketplace; ${transfers.length} TextNFT transfer(s), ${mints.length} of them mints`;
    },

    async bridge() {
        if (!BRIDGE_EVM_CHAINS.some((c) => c.chainId === config.networks.main.chainId)) {
            throw new Error("VinuChain is not among the bridge's configured EVM chains");
        }
        try {
            // The production seam: the same call and the same VinuChain
            // predicate src/api/wanbridge-token-pairs.js serves the UI from.
            const { ok, payload } = await fetchWanBridgeJson("tokenPairs");
            if (!ok || !payload.success) {
                notes.push(`bridge: ${WANBRIDGE_API_BASE}/tokenPairs answered without success; not treated as a failure`);
                return "configured; upstream did not answer this run";
            }
            const pairs = payload.data.filter(
                (pair) =>
                    pair.fromChain?.chainType === VINUCHAIN_CHAIN_TYPE ||
                    pair.toChain?.chainType === VINUCHAIN_CHAIN_TYPE
            );
            if (!pairs.length) {
                throw new Error("WanBridge answered but lists no VinuChain token pair — the bridge page would be empty");
            }
            const routes = buildVinuChainRoutes(pairs);
            return `${pairs.length} VinuChain token pair(s), ${routes.length} route(s) buildable`;
        } catch (e) {
            if (e.message.includes("no VinuChain token pair")) throw e;
            notes.push(`bridge: could not reach ${WANBRIDGE_API_BASE} (${e.message}); not treated as a failure`);
            return "configured; upstream not reachable this run";
        }
    },

    async content() {
        // The production seam, not a copy of it: the same fetch + Joi schema
        // the NFT page runs before anything renders.
        const uri = await text.uri(1);
        const { metadata, source } = await fetchTokenMetadata(uri);
        if (!metadata.name) throw new Error("token 1's metadata has no name after validation");
        const blocklist = JSON.parse(src("src/content-blocklist.json"));
        if (blocklist.entries.length) {
            notes.push(`content: ${blocklist.entries.length} token(s) are hidden by src/content-blocklist.json`);
        }
        const imageUri = await image.uri(1);
        if (imageUri.startsWith("ipfs://")) {
            const gateway = `${config.ipfsGateways[0]}/${imageUri.slice("ipfs://".length)}`;
            try {
                const response = await fetch(gateway, { method: "HEAD", signal: AbortSignal.timeout(15000) });
                if (!response.ok) notes.push(`content: ${config.ipfsGateways[0]} returned HTTP ${response.status} for image#1`);
            } catch (e) {
                notes.push(`content: ${config.ipfsGateways[0]} unreachable this run (${e.message})`);
            }
        }
        return `text#1 metadata "${metadata.name}" (${source}) passed schemas.tokenMetadata; blocklist ${blocklist.entries.length} entr(y|ies)`;
    },

    async recovery() {
        // The deployed buyToken is payable and the Marketplace has no payout
        // path, so native VC that reaches it is stranded forever. What makes
        // this safe is that no product path sends value — assert both halves.
        const balance = await provider.getBalance(config.contractAddresses.v1.marketplace);
        if (!balance.isZero()) {
            throw new Error(
                `${balance} wei is stranded in the Marketplace; the deployed contract has no withdraw path`
            );
        }
        const buyButton = src("src/components/BuyButton.js");
        if (/buyToken\([^)]*\{[\s\S]*?value:/.test(buyButton)) {
            throw new Error("BuyButton passes a value override to buyToken, which the Marketplace cannot pay back out");
        }
        return "Marketplace native balance 0 wei; no product call site sends value";
    },
};

const results = {};
for (const [journey, probe] of Object.entries(probes)) {
    try {
        results[journey] = { reads: "ok", writes: EXPECTED[journey].writes === "n/a" ? "n/a" : writes, detail: await probe() };
    } catch (e) {
        results[journey] = { reads: `FAILED: ${e.message}`, writes: EXPECTED[journey].writes === "n/a" ? "n/a" : writes, detail: "" };
    }
}

console.log(`chain ${netChainId} via ${config.rpc}, head ${head}\n`);
const pad = Math.max(...Object.keys(results).map((k) => k.length));
for (const [journey, r] of Object.entries(results)) {
    console.log(`${journey.padEnd(pad)}  reads ${r.reads === "ok" ? "ok" : r.reads}  |  writes ${r.writes}${r.detail ? `\n${" ".repeat(pad + 2)}${r.detail}` : ""}`);
}
if (notes.length) {
    console.log("");
    for (const n of notes) console.log(`note: ${n}`);
}

const drift = [];
for (const [journey, expected] of Object.entries(EXPECTED)) {
    const r = results[journey];
    if (r.reads !== expected.reads) drift.push(`${journey}: expected reads ${expected.reads}, got ${r.reads}`);
    if (r.writes !== expected.writes) {
        drift.push(
            `${journey}: expected writes ${expected.writes}, got ${r.writes} — the committed ` +
                "readiness claim in scripts/production-readiness.mjs no longer describes this environment"
        );
    }
}

if (drift.length) {
    console.error(`\nFAIL (${drift.length}):`);
    for (const d of drift) console.error(`  ${d}`);
    process.exit(1);
}
console.log(
    `\nOK: ${Object.keys(EXPECTED).length} journeys match the committed readiness claim.\n` +
        "Every write path above is BLOCKED: no funded chain-207 account exists here, so mint, list, " +
        "buy, transfer, burn and bridge have not been executed against the deployed contracts by anyone " +
        "running this. Read-only agreement is not evidence that they would succeed."
);
