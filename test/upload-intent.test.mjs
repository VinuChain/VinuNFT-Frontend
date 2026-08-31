import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

process.env.PINATA_MAX_UPLOADS_PER_WINDOW = "500";
process.env.PINATA_MAX_GLOBAL_UPLOADS_PER_WINDOW = "500";

const { default: handler } = await import("../src/api/upload-ipfs.js");
const { createUploadMessage, uploadPayloadDigest, canonicalJson, UPLOAD_INTENT_VERSION } =
    await import("../src/common/uploadIntent.js");

const CHAIN = 207;
const ACTION = { file: "mint-image", json: "mint-metadata" };

function jsonBody(metadata = {}) {
    return { type: "json", metadata: { name: "Bound NFT", ...metadata } };
}

function fileBody(overrides = {}) {
    return {
        type: "file",
        name: "art.png",
        contentType: "image/png",
        size: 4,
        data: Buffer.from("art!").toString("base64"),
        ...overrides,
    };
}

async function authFor(wallet, payload, overrides = {}) {
    const issuedAt = new Date().toISOString();
    const message = createUploadMessage({
        address: ethers.utils.getAddress(wallet.address),
        issuedAt,
        chainId: CHAIN,
        action: ACTION[payload.type],
        digest: uploadPayloadDigest(payload),
        ...overrides,
    });
    return { address: wallet.address, issuedAt, signature: await wallet.signMessage(message) };
}

function request(body, remoteAddress = "203.0.113.10") {
    return { method: "POST", headers: {}, socket: { remoteAddress }, body };
}

function response() {
    return {
        statusCode: null, body: null, headers: {},
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { this.headers[k] = v; },
        send(b) { this.body = b; return this; },
    };
}

async function post(wallet, payload, auth) {
    process.env.PINATA_API_JWT = "pinata.jwt.secret";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = wallet.address;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"IpfsHash":"QmOk"}' });
    const res = response();
    const warn = console.warn, info = console.info;
    console.warn = () => {}; console.info = () => {};
    try {
        await handler(request({ ...payload, auth }), res);
    } finally {
        console.warn = warn; console.info = info;
    }
    return res;
}

// --- canonical digest -------------------------------------------------------

test("canonicalJson is independent of property order", () => {
    assert.equal(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
    assert.equal(uploadPayloadDigest({ x: 1, y: 2 }), uploadPayloadDigest({ y: 2, x: 1 }));
});

test("canonicalJson preserves array order and distinguishes different content", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
    assert.notEqual(uploadPayloadDigest(jsonBody()), uploadPayloadDigest(jsonBody({ name: "Other" })));
});

test("createUploadMessage refuses to build an unbound intent", () => {
    const full = { address: "0x1", issuedAt: "t", chainId: 207, action: "mint-image", digest: "0xd" };
    assert.ok(createUploadMessage(full).includes(`Version: ${UPLOAD_INTENT_VERSION}`));
    for (const field of Object.keys(full)) {
        assert.throws(() => createUploadMessage({ ...full, [field]: undefined }), new RegExp(field));
    }
});

// --- server enforcement -----------------------------------------------------

test("a correctly bound signature is accepted", async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = jsonBody();
    const res = await post(wallet, payload, await authFor(wallet, payload));
    assert.equal(res.statusCode, 200);
});

test("a signature bound to different metadata is rejected", async () => {
    const wallet = ethers.Wallet.createRandom();
    const auth = await authFor(wallet, jsonBody());
    // Same wallet, same window, tampered content — this is the replay the
    // previous address+timestamp-only signature could not detect.
    const res = await post(wallet, jsonBody({ name: "Swapped Out" }), auth);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /does not authorise this payload/);
});

test("a signature bound to different file bytes is rejected", async () => {
    const wallet = ethers.Wallet.createRandom();
    const auth = await authFor(wallet, fileBody());
    const res = await post(wallet, fileBody({ data: Buffer.from("evil").toString("base64") }), auth);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /does not authorise this payload/);
});

test("a file-upload signature cannot authorise a metadata upload", async () => {
    const wallet = ethers.Wallet.createRandom();
    const file = fileBody();
    // Reuse the file's signature against a JSON payload carrying the same digest
    // input, so only the bound action can distinguish them.
    const auth = await authFor(wallet, file);
    const res = await post(wallet, { ...jsonBody(), _digestSource: file }, auth);
    assert.equal(res.statusCode, 400);
});

test("a version-1 signature (address and timestamp only) is rejected", async () => {
    const wallet = ethers.Wallet.createRandom();
    const issuedAt = new Date().toISOString();
    const legacy = [
        "VinuNFT IPFS upload",
        `Address: ${ethers.utils.getAddress(wallet.address)}`,
        `Issued At: ${issuedAt}`,
        "Purpose: mint-image",
    ].join("\n");
    const auth = { address: wallet.address, issuedAt, signature: await wallet.signMessage(legacy) };
    const res = await post(wallet, jsonBody(), auth);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /does not authorise this payload/);
});

test("a signature bound to another chain is rejected", async () => {
    const wallet = ethers.Wallet.createRandom();
    const payload = jsonBody();
    const auth = await authFor(wallet, payload, { chainId: 1 });
    const res = await post(wallet, payload, auth);
    assert.equal(res.statusCode, 400);
});

test("an unsupported upload type is rejected before any pinning", async () => {
    const wallet = ethers.Wallet.createRandom();
    let pinned = false;
    process.env.PINATA_API_JWT = "pinata.jwt.secret";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = wallet.address;
    globalThis.fetch = async () => { pinned = true; return { ok: true, status: 200, text: async () => "{}" }; };
    const res = response();
    const warn = console.warn, info = console.info;
    console.warn = () => {}; console.info = () => {};
    try {
        await handler(request({ type: "sneaky", auth: { address: wallet.address, issuedAt: new Date().toISOString(), signature: "0x00" } }), res);
    } finally { console.warn = warn; console.info = info; }
    assert.equal(res.statusCode, 400);
    assert.equal(pinned, false);
});
