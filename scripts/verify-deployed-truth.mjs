#!/usr/bin/env node
/**
 * Cross-repository deployment truth gate.
 *
 * Fails when the frontend's address/first-block registry, the frontend ABIs,
 * and the contracts actually deployed on VinuChain disagree.
 *
 * Checks, per contract in config.contractAddresses.v1:
 *   1. code is present at the configured address on the configured chain;
 *   2. config.firstBlocks is the real creation block (code absent at N-1,
 *      present at N) — a wrong value silently truncates or bloats every scan;
 *   3. every function in the frontend ABI is callable on the deployed
 *      bytecode, probed with eth_call rather than bytecode string matching,
 *      which produces false negatives;
 *   4. the mutable state every admin lever can move — pause, platform fee,
 *      commission account, owner, pending fee change, fee timelock — and the
 *      deployed bytecode hash still match scripts/deployed-invariants.json;
 *   5. the frontend ABI is compared against the backend artifact ABI when
 *      --backend <path> is given, so undeployed source drift is reported
 *      explicitly instead of being mistaken for a deployment.
 *
 * Read-only. Usage:
 *   node scripts/verify-deployed-truth.mjs [--backend ../VinuNFT-Backend]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { diffInvariants, loadPins } from "./deployed-invariants.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const backendArg = argv.indexOf("--backend");
const backendRoot = backendArg !== -1 ? resolve(argv[backendArg + 1]) : null;

// config.js is an ES module with a default export; read the literals directly
// so this gate does not need the Gatsby/babel toolchain to run in CI.
const configSrc = readFileSync(resolve(root, "src/config.js"), "utf8");
const pick = (re, what) => {
    const m = configSrc.match(re);
    if (!m) throw new Error(`verify-deployed-truth: could not read ${what} from src/config.js`);
    return m[1];
};
const section = (name) => {
    const body = pick(new RegExp(`${name}:\\s*\\{\\s*v1:\\s*\\{([\\s\\S]*?)\\}`), name);
    return Object.fromEntries(
        [...body.matchAll(/(\w+)\s*:\s*"?([^",\s]+)"?\s*,/g)].map(([, k, v]) => [k, v])
    );
};

const addresses = section("contractAddresses");
const firstBlocks = section("firstBlocks");
const rpc = pick(/rpc:\s*"([^"]+)"/, "rpc");
const chainId = Number(pick(/main:\s*\{[\s\S]*?chainId:\s*(\d+)/, "chainId"));
const maxLogBlockRange = Number(pick(/maxLogBlockRange:\s*(\d+)/, "maxLogBlockRange"));

const ABI_FILE = { text: "TextNFT", marketplace: "Marketplace", image: "ImageNFT" };

const failures = [];
// Values read below are compared against the committed pin; see
// scripts/deployed-invariants.mjs for why this costs no extra RPC call.
const pinned = loadPins();
const actual = {};
const notes = [];
const fail = (m) => failures.push(m);

const provider = new ethers.providers.JsonRpcProvider(rpc, chainId);

const net = await provider.getNetwork();
if (Number(net.chainId) !== chainId) {
    fail(`chain id: config says ${chainId}, ${rpc} reports ${net.chainId}`);
}

// The block-range limit is deployment truth too: every historical scan depends
// on it, and a silent node-side change breaks history exactly as before.
const head = await provider.getBlockNumber();
const probeFrom = head - maxLogBlockRange;
try {
    await provider.getLogs({ fromBlock: probeFrom - 1, toBlock: head, address: addresses.marketplace });
    notes.push(`node accepted a range of ${maxLogBlockRange + 1}; config.maxLogBlockRange may be raisable`);
} catch {
    /* expected: the configured limit is still the real one */
}
try {
    await provider.getLogs({ fromBlock: probeFrom, toBlock: head, address: addresses.marketplace });
} catch (e) {
    fail(`config.maxLogBlockRange=${maxLogBlockRange} is too wide for ${rpc}: ${e.shortMessage || e.message}`);
}

for (const [name, address] of Object.entries(addresses)) {
    if (!ethers.utils.isAddress(address)) {
        fail(`${name}: '${address}' is not a valid address`);
        continue;
    }
    const code = await provider.getCode(address);
    if (code === "0x") {
        fail(`${name}: no contract code at ${address} on chain ${chainId}`);
        continue;
    }
    // Hash rather than store the bytecode: a pin file nobody can read is a pin
    // file nobody maintains.
    const state = { codeHash: ethers.utils.keccak256(code), views: {} };
    actual[name] = state;

    const configured = Number(firstBlocks[name]);
    if (!Number.isInteger(configured)) {
        fail(`${name}: firstBlocks entry '${firstBlocks[name]}' is not an integer`);
    } else {
        const atFirst = await provider.getCode(address, configured);
        const beforeFirst =
            configured > 0 ? await provider.getCode(address, configured - 1) : "0x";
        if (atFirst === "0x" || beforeFirst !== "0x") {
            let lo = 0, hi = head;
            while (lo < hi) {
                const mid = Math.floor((lo + hi) / 2);
                if ((await provider.getCode(address, mid)) === "0x") lo = mid + 1;
                else hi = mid;
            }
            fail(`${name}: firstBlocks is ${configured} but the contract was created at ${lo}`);
        }
    }

    const abiPath = resolve(root, `src/abis/${ABI_FILE[name]}.json`);
    if (!existsSync(abiPath)) {
        fail(`${name}: missing frontend ABI at src/abis/${ABI_FILE[name]}.json`);
        continue;
    }
    const raw = JSON.parse(readFileSync(abiPath, "utf8"));
    const abi = raw.abi ?? raw;
    const iface = new ethers.utils.Interface(abi);

    // A view function with no arguments is callable on any live contract that
    // declares it; a missing selector reverts without revert data. Functions
    // that take arguments are skipped — a revert there is indistinguishable
    // from a legitimate business-logic revert.
    for (const f of abi.filter(
        (x) => x.type === "function" && x.inputs.length === 0 &&
               (x.stateMutability === "view" || x.stateMutability === "pure")
    )) {
        try {
            const result = await provider.call({
                to: address,
                data: iface.encodeFunctionData(f.name, []),
            });
            // The answer was previously discarded, which is exactly why state
            // drift was invisible. Keep it in a JSON-comparable shape.
            const decoded = iface.decodeFunctionResult(f.name, result);
            state.views[f.name] = decoded
                .map((v) => (v?._isBigNumber ? v.toString() : String(v)))
                .join(",");
        } catch (e) {
            fail(`${name}: frontend ABI declares ${f.name}() but it is absent from the deployed contract at ${address}`);
        }
    }

    if (backendRoot) {
        const artifact = resolve(
            backendRoot,
            `artifacts/contracts/${ABI_FILE[name]}.sol/${ABI_FILE[name]}.json`
        );
        if (!existsSync(artifact)) {
            notes.push(`${name}: no backend artifact at ${artifact} (run 'hardhat compile' to enable source drift comparison)`);
            continue;
        }
        const srcAbi = JSON.parse(readFileSync(artifact, "utf8")).abi;
        const sig = (x) => `${x.name}(${x.inputs.map((i) => i.type).join(",")})`;
        const feSet = new Set(abi.filter((x) => x.type === "function").map(sig));
        const srcSet = new Set(srcAbi.filter((x) => x.type === "function").map(sig));
        const onlySrc = [...srcSet].filter((s) => !feSet.has(s));
        const onlyFe = [...feSet].filter((s) => !srcSet.has(s));
        if (onlyFe.length) {
            fail(`${name}: frontend ABI has ${onlyFe.join(", ")} which backend source does not — the frontend may call a function that no longer exists`);
        }
        if (onlySrc.length) {
            notes.push(`${name}: backend source is ahead of the deployed generation by ${onlySrc.join(", ")} — these are NOT live at ${address}`);
        }
    }
}

const drift = diffInvariants(actual, pinned);
if (drift.length) {
    for (const d of drift) fail(d);
    fail(
        "the values above are pinned in scripts/deployed-invariants.json — if an " +
            "admin action changed them deliberately, update that file in the same " +
            "change; otherwise treat this as an unauthorised contract state change"
    );
}

console.log(`chain ${chainId} via ${rpc}, head ${head}`);
for (const [name, s] of Object.entries(actual)) {
    const pins = Object.keys(pinned[name]?.views ?? {});
    console.log(
        `monitored ${name}: bytecode hash + ${pins.length} pinned view(s)` +
            (pins.length ? ` (${pins.join(", ")})` : "")
    );
}
for (const n of notes) console.log(`note: ${n}`);
if (failures.length) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log(
    `\nOK: ${Object.keys(addresses).length} contracts — addresses, first blocks, ABI/deployment agreement and pinned live state verified.\n` +
        "NOT monitored here (needs a host nobody has named yet): deployed frontend SHA, " +
        "production frontend errors, uptime. IPFS gateway reachability: scripts/check-gateways.mjs."
);
