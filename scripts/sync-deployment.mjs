#!/usr/bin/env node
/**
 * Frontend deployment sync: point this app at a recorded deployment, coherently.
 *
 * Addresses, first blocks and ABIs are one fact in three files. Updating them
 * separately is how a build ends up calling v2 selectors at a v1 address, so
 * this writes all three from one source of truth — a backend deployment record
 * (`deployments/vinuchain-<chainId>.json`) plus that generation's compiled
 * artifacts.
 *
 * It refuses one write in particular. OpenZeppelin 5's ERC1155Supply declares a
 * zero-argument `totalSupply()` next to `totalSupply(uint256)`; ethers v5
 * resolves `contract.totalSupply(id)` BY NAME, so an ABI carrying both makes
 * that call ambiguous and blanks the edition size on every NFT page. The rule
 * generalises, so the check does too: if an incoming ABI has an overloaded
 * function name that `src/` still calls by bare name, nothing is written. Fix
 * the call site to the explicit `contract["totalSupply(uint256)"](id)` form
 * first — that form is correct against both generations.
 *
 * Usage:
  *   node scripts/sync-deployment.mjs --record ../VinuNFT-Backend/deployments/vinuchain-207.json \
 *                                    --artifacts ../VinuNFT-Backend/artifacts \
 *                                    [--generation v1] [--check]
 *
 * --check writes nothing and exits non-zero if a write would change anything.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
};
const checkOnly = argv.includes("--check");
// Which generation of src/config.js this record describes. It only ever
// rewrites values that already exist, so a cutover means adding the `v2:` block
// to contractAddresses and firstBlocks by hand FIRST — the old generation's
// entries must survive or the app loses the history of every token minted on
// it. Running with a v2 record and the default here would overwrite v1.
const generation = flag("generation") ?? "v1";

const recordPath = flag("record");
const artifactsRoot = flag("artifacts");
if (!recordPath || !artifactsRoot) {
    console.error("usage: sync-deployment.mjs --record <deployment json> --artifacts <backend artifacts dir> [--check]");
    process.exit(2);
}

const record = JSON.parse(readFileSync(resolve(recordPath), "utf8"));

// src/config.js is edited textually rather than reserialised: it is hand-written
// ES module source carrying comments that explain every value, and a
// round-trip through JSON would delete them.
const configPath = resolve(root, "src/config.js");
let configSrc = readFileSync(configPath, "utf8");

const problems = [];

// The record names the chain it was deployed to; src/config.js names the chain
// this build talks to. Nothing below would notice a mismatch — `chainId` and
// `rpc` are not among the values this script writes — so a testnet record
// syncs cleanly into the mainnet config and produces addresses that exist
// nowhere.
const configChainId = Number(
    (configSrc.match(/main:\s*\{[\s\S]*?chainId:\s*(\d+)/) ?? [])[1]
);
if (Number(record.chainId) !== configChainId) {
    problems.push(
        `record is for chain ${record.chainId}, but src/config.js is configured for chain ${configChainId} — ` +
            `syncing it would write addresses that exist on neither`
    );
}

// Every contract the target generation already has must be in the record. A
// partial record syncs what it names and reports success, leaving the omitted
// contract's old address, first block and ABI in place: the mixed-generation
// frontend this script exists to prevent.
const generationContracts = (section) => {
    const body = configSrc.match(
        new RegExp(
            `${section}:\\s*\\{(?:(?!contractAddresses:|firstBlocks:)[\\s\\S])*?\\b${generation}:\\s*\\{([\\s\\S]*?)\\}`
        )
    );
    return body ? [...body[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]) : [];
};
const missing = generationContracts("contractAddresses").filter(
    (name) => !record.contracts?.[name]
);
if (missing.length) {
    problems.push(
        `record names no ${missing.join(", ")} contract, but src/config.js ${generation} has ${missing.length === 1 ? "it" : "them"} — ` +
            `a partial sync leaves the omitted contract on the previous generation`
    );
}

const jsFiles = (dir) =>
    readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return jsFiles(full);
        return /\.jsx?$/.test(entry) ? [full] : [];
    });
const sources = jsFiles(resolve(root, "src")).map((f) => [f, readFileSync(f, "utf8")]);

const writes = [];

for (const [key, entry] of Object.entries(record.contracts ?? {})) {
    const { contractName } = entry;
    const artifactPath = resolve(
        artifactsRoot,
        `contracts/${contractName}.sol/${contractName}.json`
    );
    if (!existsSync(artifactPath)) {
        problems.push(`${key}: no artifact at ${artifactPath} — run 'yarn compile' in the backend first`);
        continue;
    }
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

    const byName = new Map();
    for (const f of artifact.abi.filter((x) => x.type === "function")) {
        byName.set(f.name, (byName.get(f.name) ?? 0) + 1);
    }
    for (const [name, count] of byName) {
        if (count < 2) continue;
        // The explicit form contract["name(types)"](…) carries no bare `.name(`,
        // so only the ambiguous call shape is reported.
        const bare = new RegExp(`\\.${name}\\s*\\(`);
        for (const [file, text] of sources) {
            if (bare.test(text)) {
                problems.push(
                    `${contractName}.${name} is overloaded ${count} ways in the incoming ABI, but ` +
                        `${file.slice(root.length + 1)} still calls .${name}(...) by name — ` +
                        `ethers resolves that by name and will throw. Use ["${name}(<types>)"](...) first.`
                );
            }
        }
    }

    writes.push([
        resolve(root, `src/abis/${contractName}.json`),
        JSON.stringify(artifact, null, 4) + "\n",
    ]);
}

const replaceInSection = (section, key, value, quoted) => {
    const re = new RegExp(
        // The lookahead keeps the search inside one section: without it, asking
        // for a generation that contractAddresses does not have would walk on
        // into firstBlocks and rewrite the wrong number.
        `(${section}:\\s*\\{(?:(?!contractAddresses:|firstBlocks:)[\\s\\S])*?\\b${generation}:\\s*\\{[\\s\\S]*?\\b${key}:\\s*)(?:"[^"]*"|\\d+)`
    );
    if (!re.test(configSrc)) {
        problems.push(
            `could not find ${section}.${generation}.${key} in src/config.js — ` +
                `add the ${generation} block alongside the existing one before syncing, do not replace it`
        );
        return;
    }
    configSrc = configSrc.replace(re, `$1${quoted ? `"${value}"` : value}`);
};
for (const [key, entry] of Object.entries(record.contracts)) {
    replaceInSection("contractAddresses", key, entry.address, true);
    replaceInSection("firstBlocks", key, entry.firstBlock, false);
}
writes.push([configPath, configSrc]);

if (problems.length) {
    console.error(`REFUSED (${problems.length}), nothing written:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
}

const changed = writes.filter(([path, content]) => readFileSync(path, "utf8") !== content);
if (checkOnly) {
    if (changed.length) {
        console.error(`--check: ${changed.length} file(s) would change:`);
        for (const [path] of changed) console.error(`  ${path.slice(root.length + 1)}`);
        process.exit(1);
    }
    console.log(`--check: src/abis and src/config.js already match ${recordPath}`);
    process.exit(0);
}

for (const [path, content] of changed) writeFileSync(path, content);
console.log(
    changed.length
        ? `wrote ${changed.map(([p]) => p.slice(root.length + 1)).join(", ")}`
        : `already in sync with ${recordPath}`
);
console.log(
    "Next: repin scripts/deployed-invariants.json, then yarn verify:deployed, yarn test, yarn build."
);
