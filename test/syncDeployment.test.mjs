import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * scripts/sync-deployment.mjs is the only supported way to point this app at a
 * new deployment, because addresses, first blocks and ABIs are one fact spread
 * over three files.
 *
 * The case that matters is the one that already exists in the backend's current
 * artifacts: OpenZeppelin 5's ERC1155Supply adds a zero-argument
 * `totalSupply()`, ethers v5 resolves `contract.totalSupply(id)` by name, and
 * an ABI carrying both overloads makes that call throw. Everything here is
 * built in a temp directory so the test does not depend on the backend
 * repository being checked out beside this one.
 */
// Not import.meta.dirname: that lands in Node 21 and CI runs Node 20.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts/sync-deployment.mjs");

function fixture(mutateAbi = (abi) => abi) {
    const dir = mkdtempSync(join(tmpdir(), "vinunft-sync-"));
    for (const name of ["TextNFT", "ImageNFT", "Marketplace"]) {
        const artifact = JSON.parse(
            readFileSync(join(root, `src/abis/${name}.json`), "utf8")
        );
        artifact.abi = mutateAbi(artifact.abi, name);
        mkdirSync(join(dir, "contracts", `${name}.sol`), { recursive: true });
        writeFileSync(
            join(dir, "contracts", `${name}.sol`, `${name}.json`),
            JSON.stringify(artifact, null, 4) + "\n"
        );
    }
    // The addresses and first blocks currently in src/config.js, so a run that
    // changes nothing is the baseline and any diff is the thing under test.
    const record = {
        chainId: 207,
        contracts: {
            text: { contractName: "TextNFT", address: "0x8974168eC4c942C6D34161e994A759DC3F19b5a8", firstBlock: 2234593 },
            image: { contractName: "ImageNFT", address: "0xDE63a95387b89679869591351f5bFD897Dc87DFB", firstBlock: 2232056 },
            marketplace: { contractName: "Marketplace", address: "0xcA396A95E0EB8B6804e25F9db131780a60564047", firstBlock: 2232125 },
        },
    };
    writeFileSync(join(dir, "record.json"), JSON.stringify(record, null, 2));
    return dir;
}

function run(dir, recordName = "record.json", extra = []) {
    try {
        const stdout = execFileSync(
            process.execPath,
            [SCRIPT, "--record", join(dir, recordName), "--artifacts", dir, "--check", ...extra],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        return { code: 0, output: stdout };
    } catch (e) {
        return { code: e.status, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
}

const zeroArgTotalSupply = {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
};

test("an ABI matching the deployed generation syncs cleanly", () => {
    const dir = fixture();
    try {
        const { code, output } = run(dir);
        assert.equal(code, 0, output);
        assert.match(output, /already match/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("refuses an ABI that reintroduces totalSupply() while src still calls it by name", () => {
    const dir = fixture((abi, name) =>
        name === "Marketplace" ? abi : [...abi, zeroArgTotalSupply]
    );
    try {
        const { code, output } = run(dir);
        assert.equal(code, 1);
        assert.match(output, /REFUSED/);
        // Both NFT contracts, named, with the call site that would break.
        assert.match(output, /TextNFT\.totalSupply is overloaded 2 ways/);
        assert.match(output, /ImageNFT\.totalSupply is overloaded 2 ways/);
        assert.match(output, /src\/pages\/nft\/index\.js still calls \.totalSupply\(\.\.\.\) by name/);
        assert.equal(output.includes("wrote "), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an overload src never calls by name is not refused", () => {
    // Same defect shape, different function: the guard must key on the call
    // site, not on the mere presence of an overload, or every future ABI is
    // unsyncable.
    const dir = fixture((abi, name) =>
        name === "Marketplace"
            ? abi
            : [...abi, { ...zeroArgTotalSupply, name: "unusedElsewhere" },
                        { ...zeroArgTotalSupply, name: "unusedElsewhere", inputs: [{ internalType: "uint256", name: "id", type: "uint256" }] }]
    );
    try {
        const { code, output } = run(dir);
        // The ABI genuinely differs from the one on disk, so --check reports a
        // pending write; what must not happen is a refusal.
        assert.equal(output.includes("REFUSED"), false, output);
        assert.match(output, /would change/);
        assert.equal(code, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("refuses a generation src/config.js does not have, instead of overwriting v1", () => {
    const dir = fixture();
    try {
        const { code, output } = run(dir, "record.json", ["--generation", "v2"]);
        assert.equal(code, 1);
        assert.match(output, /REFUSED/);
        assert.match(output, /could not find contractAddresses\.v2\.text/);
        assert.match(output, /add the v2 block alongside the existing one before syncing/);
        // v1 must be untouched: a cutover that replaces it deletes the history
        // of every token minted on the old contracts.
        assert.match(readFileSync(join(root, "src/config.js"), "utf8"), /text: 2234593/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a first block that disagrees with src/config.js is a change, not a no-op", () => {
    const dir = fixture();
    try {
        const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
        record.contracts.text.firstBlock = 2234594;
        writeFileSync(join(dir, "drift.json"), JSON.stringify(record, null, 2));

        const { code, output } = run(dir, "drift.json");
        assert.equal(code, 1);
        assert.match(output, /src\/config\.js/);
        // --check must not have written it.
        assert.match(readFileSync(join(root, "src/config.js"), "utf8"), /text: 2234593/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** The fixture record, with one field changed, written beside it. */
function variantRecord(dir, mutate, name = "variant.json") {
    const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
    writeFileSync(join(dir, name), JSON.stringify(mutate(record), null, 2));
    return name;
}

test("refuses a record from another chain", () => {
    // A chain-206 record carries valid-looking addresses that exist nowhere on
    // 207. Nothing else in this script would notice: networks.main.chainId and
    // rpc are not written, so the result is a coherent, unusable frontend.
    const dir = fixture();
    try {
        const name = variantRecord(dir, (r) => ({ ...r, chainId: 206 }));
        const { code, output } = run(dir, name);
        assert.equal(code, 1);
        assert.match(output, /REFUSED/);
        assert.match(output, /chain 206.*chain 207|206.*207/s);
        assert.equal(output.includes("wrote "), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("refuses a record missing one of the deployed contracts", () => {
    // A partial record syncs the contracts it names and reports success, while
    // the omitted one keeps its old address, first block and ABI — exactly the
    // mixed-generation frontend this script exists to prevent.
    const dir = fixture();
    try {
        const name = variantRecord(dir, (r) => {
            const contracts = { ...r.contracts };
            delete contracts.image;
            return { ...r, contracts };
        });
        const { code, output } = run(dir, name);
        assert.equal(code, 1);
        assert.match(output, /REFUSED/);
        assert.match(output, /image/);
        assert.equal(output.includes("wrote "), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
