import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

process.env.PINATA_MAX_UPLOADS_PER_WINDOW = "1";
process.env.PINATA_MAX_GLOBAL_UPLOADS_PER_WINDOW = "50";

const { default: handler } = await import("../src/api/upload-ipfs.js");

function uploadMessage(address, issuedAt) {
    return [
        "VinuNFT IPFS upload",
        `Address: ${ethers.utils.getAddress(address)}`,
        `Issued At: ${issuedAt}`,
        "Purpose: mint-image",
    ].join("\n");
}

async function signedAuth(wallet) {
    const issuedAt = new Date().toISOString();

    return {
        address: wallet.address,
        issuedAt,
        signature: await wallet.signMessage(
            uploadMessage(wallet.address, issuedAt)
        ),
    };
}

function jsonPayload(auth, metadata = {}) {
    return {
        type: "json",
        auth,
        metadata: {
            name: "Audit Test NFT",
            description: "private draft text that must not be logged",
            ...metadata,
        },
    };
}

function request(body, remoteAddress = "203.0.113.42") {
    return {
        method: "POST",
        headers: {},
        socket: { remoteAddress },
        body,
    };
}

function response() {
    return {
        statusCode: null,
        headers: {},
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value;
        },
        send(body) {
            this.body = body;
            return this;
        },
    };
}

async function captureAuditEvents(run) {
    const events = [];
    const originalInfo = console.info;
    const originalWarn = console.warn;

    console.info = (line) => events.push(JSON.parse(line));
    console.warn = (line) => events.push(JSON.parse(line));

    try {
        await run();
    } finally {
        console.info = originalInfo;
        console.warn = originalWarn;
    }

    return events;
}

function assertRedacted(event, forbiddenValues) {
    const serialized = JSON.stringify(event);

    assert.equal(event.event, "vinunft.ipfs_upload");
    assert.match(event.clientIpHash, /^[a-f0-9]{16}$/);
    assert.ok(!("signature" in event));
    assert.ok(!("jwt" in event));

    for (const value of forbiddenValues) {
        assert.equal(serialized.includes(value), false, value);
    }
}

test("upload audit logs missing JWT without leaking request content", async () => {
    delete process.env.PINATA_API_JWT;
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES =
        ethers.Wallet.createRandom().address;

    const res = response();
    const events = await captureAuditEvents(() =>
        handler(request(jsonPayload(null)), res)
    );

    assert.equal(res.statusCode, 400);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "rejected");
    assert.equal(events[0].reason, "missing_pinata_jwt");
    assertRedacted(events[0], [
        "203.0.113.42",
        "private draft text",
        process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES,
    ]);
});

test("upload audit logs unauthorized wallets with a hashed wallet id", async () => {
    const wallet = ethers.Wallet.createRandom();
    process.env.PINATA_API_JWT = "pinata.jwt.secret";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES =
        ethers.Wallet.createRandom().address;

    const auth = await signedAuth(wallet);
    const res = response();
    const events = await captureAuditEvents(() =>
        handler(request(jsonPayload(auth), "203.0.113.43"), res)
    );

    assert.equal(res.statusCode, 400);
    assert.equal(events[0].reason, "wallet_not_allowed");
    assert.match(events[0].walletHash, /^[a-f0-9]{16}$/);
    assertRedacted(events[0], [
        wallet.address,
        auth.signature,
        "pinata.jwt.secret",
        "203.0.113.43",
        "private draft text",
    ]);
});

test("upload audit logs rate-limit rejections separately from success", async () => {
    const wallet = ethers.Wallet.createRandom();
    process.env.PINATA_API_JWT = "pinata.jwt.secret";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = wallet.address;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => '{"IpfsHash":"QmSuccess"}',
    });

    const firstAuth = await signedAuth(wallet);
    const secondAuth = await signedAuth(wallet);
    const events = await captureAuditEvents(async () => {
        await handler(
            request(jsonPayload(firstAuth), "203.0.113.44"),
            response()
        );
        await handler(
            request(jsonPayload(secondAuth), "203.0.113.44"),
            response()
        );
    });

    assert.equal(
        events.map((event) => event.outcome).join(","),
        "success,rejected"
    );
    assert.equal(events[0].reason, "pinata_ok");
    assert.equal(events[1].reason, "rate_limited");
    assertRedacted(events[1], [
        wallet.address,
        secondAuth.signature,
        "pinata.jwt.secret",
        "203.0.113.44",
        "private draft text",
    ]);
});

test("upload audit logs Pinata non-OK responses without provider payloads", async () => {
    const wallet = ethers.Wallet.createRandom();
    process.env.PINATA_API_JWT = "pinata.jwt.secret";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = wallet.address;
    globalThis.fetch = async () => ({
        ok: false,
        status: 502,
        text: async () => "provider body should stay out of audit logs",
    });

    const auth = await signedAuth(wallet);
    const res = response();
    const events = await captureAuditEvents(() =>
        handler(request(jsonPayload(auth), "203.0.113.45"), res)
    );

    assert.equal(res.statusCode, 502);
    assert.equal(events[0].outcome, "pinata_rejected");
    assert.equal(events[0].reason, "pinata_non_ok");
    assert.equal(events[0].pinataStatus, 502);
    assertRedacted(events[0], [
        wallet.address,
        auth.signature,
        "pinata.jwt.secret",
        "203.0.113.45",
        "provider body should stay out of audit logs",
        "private draft text",
    ]);
});
