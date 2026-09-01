import assert from "node:assert/strict";
import test from "node:test";

const ipfs = await import("../src/common/ipfs.js");
const { uploadJSONToIpfs, clearUploadCache } = ipfs.default || ipfs;

const realFetch = globalThis.fetch;

function harness() {
    const calls = { uploads: 0, signatures: 0 };

    globalThis.fetch = async () => {
        calls.uploads += 1;
        return {
            ok: true,
            json: async () => ({ IpfsHash: `Qm${calls.uploads}` }),
        };
    };

    const walletProvider = {
        getSigner: () => ({
            getAddress: async () => `0x${"12".repeat(20)}`,
            signMessage: async () => {
                calls.signatures += 1;
                return `0x${"ab".repeat(65)}`;
            },
        }),
    };

    return { calls, walletProvider };
}

test.beforeEach(() => clearUploadCache());
test.afterEach(() => {
    globalThis.fetch = realFetch;
});

test("re-uploading the same payload reuses the CID, spending no signature", async () => {
    const { calls, walletProvider } = harness();
    const metadata = { name: "A", description: "B", image: "ipfs://x" };

    const first = await uploadJSONToIpfs(metadata, walletProvider);
    const second = await uploadJSONToIpfs({ ...metadata }, walletProvider);

    assert.equal(first, second);
    assert.equal(calls.uploads, 1);
    assert.equal(calls.signatures, 1);
});

test("a different payload is a different upload", async () => {
    const { calls, walletProvider } = harness();

    await uploadJSONToIpfs({ name: "A" }, walletProvider);
    await uploadJSONToIpfs({ name: "B" }, walletProvider);

    assert.equal(calls.uploads, 2);
});

test("clearing the cache makes the next upload real again", async () => {
    const { calls, walletProvider } = harness();

    await uploadJSONToIpfs({ name: "A" }, walletProvider);
    clearUploadCache();
    await uploadJSONToIpfs({ name: "A" }, walletProvider);

    assert.equal(calls.uploads, 2);
});
