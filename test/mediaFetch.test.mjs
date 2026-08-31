import assert from "node:assert/strict";
import test from "node:test";

const ipfs = await import("../src/common/ipfs.js");
const { maybeFetchIpfs, isAllowedHttpsUrl, UnsupportedMediaSource, MediaTooLarge } =
    ipfs.default || ipfs;
const cfg = await import("../src/config.js");
const config = cfg.default || cfg;

const realFetch = globalThis.fetch;
function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push(String(url));
        return handler(String(url), init);
    };
    return calls;
}
test.afterEach(() => {
    globalThis.fetch = realFetch;
});

const okResponse = (body = "hi", headers = {}) =>
    new Response(body, { status: 200, headers: { "content-type": "text/plain", ...headers } });

// --- source policy ----------------------------------------------------------

test("a token URI pointing at a private address is refused, and no request is made", async () => {
    // ImageNFT.mint stores any string, and this runs in the viewer's browser.
    // Fetching would probe the viewer's own network and log their address.
    const calls = stubFetch(() => okResponse());
    for (const url of [
        "http://192.168.1.1/admin",
        "http://127.0.0.1:8545/",
        "http://localhost/",
        "http://169.254.169.254/latest/meta-data/",
        "https://evil.example/track.png",
        "http://[::1]/",
    ]) {
        await assert.rejects(() => maybeFetchIpfs(url), UnsupportedMediaSource, `should refuse ${url}`);
    }
    assert.deepEqual(calls, [], "no request may be issued for a refused source");
});

test("non-http schemes are refused without a request", async () => {
    const calls = stubFetch(() => okResponse());
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x/y", "", null, undefined]) {
        await assert.rejects(() => maybeFetchIpfs(url), UnsupportedMediaSource);
    }
    assert.deepEqual(calls, []);
});

test("data: URLs are served inline, which is how on-chain text metadata loads", async () => {
    const calls = stubFetch(() => okResponse("on-chain"));
    const res = await maybeFetchIpfs("data:application/json;base64,e30=");
    assert.equal(await res.text(), "on-chain");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith("data:"));
});

test("an https URL is fetched only when it is one of the configured gateways", () => {
    assert.equal(isAllowedHttpsUrl(`${config.ipfsGateways[0]}/QmX`), true);
    assert.equal(isAllowedHttpsUrl("https://evil.example/QmX"), false);
    assert.equal(isAllowedHttpsUrl("http://gateway.pinata.cloud/ipfs/QmX"), false);
    assert.equal(isAllowedHttpsUrl("not a url"), false);
});

// --- gateway resilience -----------------------------------------------------

test("ipfs:// resolves through the first working gateway", async () => {
    const calls = stubFetch(() => okResponse("image-bytes"));
    const res = await maybeFetchIpfs("ipfs://QmTest");
    assert.equal(await res.text(), "image-bytes");
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `${config.ipfsGateways[0]}/QmTest`);
});

test("a failing gateway falls through to the next rather than blanking the image", async () => {
    const calls = stubFetch((url) => {
        if (url.startsWith(config.ipfsGateways[0])) throw new Error("gateway down");
        return okResponse("recovered");
    });
    const res = await maybeFetchIpfs("ipfs://QmTest");
    assert.equal(await res.text(), "recovered");
    assert.equal(calls.length, 2);
});

test("every gateway failing surfaces an error instead of hanging or returning empty", async () => {
    stubFetch(() => {
        throw new Error("all down");
    });
    await assert.rejects(() => maybeFetchIpfs("ipfs://QmTest"), /all down/);
});

test("a non-ok gateway response is treated as a failure and falls through", async () => {
    const calls = stubFetch((url) =>
        url.startsWith(config.ipfsGateways[0])
            ? new Response("nope", { status: 504 })
            : okResponse("second")
    );
    assert.equal(await (await maybeFetchIpfs("ipfs://QmTest")).text(), "second");
    assert.equal(calls.length, 2);
});

test("an ipfs:// path with a subpath is preserved through the gateway", async () => {
    const calls = stubFetch(() => okResponse());
    await maybeFetchIpfs("ipfs://QmTest/nested/file.png");
    assert.equal(calls[0], `${config.ipfsGateways[0]}/QmTest/nested/file.png`);
});

// --- size limits ------------------------------------------------------------

test("a declared Content-Length over the cap is rejected before reading the body", async () => {
    stubFetch(() =>
        new Response("x", {
            status: 200,
            headers: { "content-length": String(config.maxMediaFetchBytes + 1) },
        })
    );
    await assert.rejects(() => maybeFetchIpfs("ipfs://QmBig"), MediaTooLarge);
});

test("a body exceeding the cap is rejected even when Content-Length lies", async () => {
    const oversized = new Uint8Array(config.maxMediaFetchBytes + 1024);
    stubFetch(() => new Response(oversized, { status: 200 }));
    await assert.rejects(() => maybeFetchIpfs("ipfs://QmLiar"), MediaTooLarge);
});

test("an oversized response is not retried against every other gateway", async () => {
    // Too large is a property of the content, not the gateway; retrying would
    // just download it again.
    const calls = stubFetch(
        () =>
            new Response("x", {
                status: 200,
                headers: { "content-length": String(config.maxMediaFetchBytes + 1) },
            })
    );
    await assert.rejects(() => maybeFetchIpfs("ipfs://QmBig"), MediaTooLarge);
    assert.equal(calls.length, 1);
});

test("content within the cap passes through with its body intact", async () => {
    const payload = "a".repeat(1024);
    stubFetch(() => okResponse(payload));
    assert.equal(await (await maybeFetchIpfs("ipfs://QmSmall")).text(), payload);
});

// --- timeout ----------------------------------------------------------------

test("a request carries an abort signal so a hanging gateway cannot stall forever", async () => {
    let sawSignal = false;
    stubFetch((_url, init) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return okResponse();
    });
    await maybeFetchIpfs("ipfs://QmTest");
    assert.equal(sawSignal, true);
    assert.ok(config.mediaFetchTimeoutMs > 0 && config.mediaFetchTimeoutMs <= 30000);
});
