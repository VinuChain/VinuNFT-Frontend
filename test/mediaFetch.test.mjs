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
    // This previously asserted that fetch() WAS called with the data: URL, so
    // it passed while the feature was broken in production: fetch() on a data:
    // URL is governed by CSP connect-src, which does not list data:, so every
    // text NFT body was refused and the page held a permanent skeleton.
    const calls = stubFetch(() => okResponse("unused"));
    const res = await maybeFetchIpfs("data:application/json;base64,e30=");
    assert.deepEqual(await res.json(), {});
    assert.deepEqual(calls, []);
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
    const res = await maybeFetchIpfs("ipfs://QmGatewayFirst");
    assert.equal(await res.text(), "image-bytes");
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `${config.ipfsGateways[0]}/QmGatewayFirst`);
});

test("a failing gateway falls through to the next rather than blanking the image", async () => {
    const calls = stubFetch((url) => {
        if (url.startsWith(config.ipfsGateways[0])) throw new Error("gateway down");
        return okResponse("recovered");
    });
    const res = await maybeFetchIpfs("ipfs://QmGatewayFallback");
    assert.equal(await res.text(), "recovered");
    assert.equal(calls.length, 2);
});

test("every gateway failing surfaces an error instead of hanging or returning empty", async () => {
    stubFetch(() => {
        throw new Error("all down");
    });
    await assert.rejects(() => maybeFetchIpfs("ipfs://QmAllDown"), /all down/);
});

test("a non-ok gateway response is treated as a failure and falls through", async () => {
    const calls = stubFetch((url) =>
        url.startsWith(config.ipfsGateways[0])
            ? new Response("nope", { status: 504 })
            : okResponse("second")
    );
    assert.equal(await (await maybeFetchIpfs("ipfs://QmNonOk")).text(), "second");
    assert.equal(calls.length, 2);
});

test("an ipfs:// path with a subpath is preserved through the gateway", async () => {
    const calls = stubFetch(() => okResponse());
    await maybeFetchIpfs("ipfs://QmSubpath/nested/file.png");
    assert.equal(calls[0], `${config.ipfsGateways[0]}/QmSubpath/nested/file.png`);
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
    await maybeFetchIpfs("ipfs://QmSignal");
    assert.equal(sawSignal, true);
    assert.ok(config.mediaFetchTimeoutMs > 0 && config.mediaFetchTimeoutMs <= 30000);
});

// ---------------------------------------------------------------------------
// data: URIs — every text NFT carries its body this way
// ---------------------------------------------------------------------------

test("maybeFetchIpfs decodes a base64 data: URI without any network call", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => {
        fetched++;
        throw new Error("network must not be reached for a data: URI");
    };
    try {
        const body = "VinuChain in a Nutshell";
        const uri = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`;
        const response = await maybeFetchIpfs(uri);
        assert.equal(await response.text(), body);
        assert.equal(response.headers.get("content-type"), "text/plain");
        // fetch() on a data: URL is governed by CSP connect-src, which does not
        // list data: — going near the network is the defect, not a detail.
        assert.equal(fetched, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("maybeFetchIpfs decodes a percent-encoded data: URI and preserves Unicode", async () => {
    const response = await maybeFetchIpfs("data:text/plain,caf%C3%A9%20%E2%9C%93");
    assert.equal(await response.text(), "café ✓");
});

test("maybeFetchIpfs decodes the on-chain JSON metadata shape", async () => {
    const metadata = { name: "Token", description: "on chain" };
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString("base64")}`;
    const response = await maybeFetchIpfs(uri);
    assert.deepEqual(await response.json(), metadata);
});

test("maybeFetchIpfs refuses a malformed data: URI instead of returning junk", async () => {
    await assert.rejects(
        () => maybeFetchIpfs("data:text/plain;base64,!!!not-base64!!!"),
        (e) => e.name === "UnsupportedMediaSource"
    );
    await assert.rejects(
        () => maybeFetchIpfs("data:no-comma-here"),
        (e) => e.name === "UnsupportedMediaSource"
    );
});

// --- caching and freshness --------------------------------------------------

test("the same CID is fetched once, so a card then its detail page costs one request", async () => {
    const calls = stubFetch(() => okResponse("cached-body"));
    const first = await maybeFetchIpfs("ipfs://QmCacheA");
    const second = await maybeFetchIpfs("ipfs://QmCacheA");
    assert.equal(calls.length, 1, "a second read of the same CID must not hit a gateway");
    assert.equal(await first.text(), "cached-body");
    assert.equal(await second.text(), "cached-body", "each caller needs its own readable body");
});

test("a CID already read survives every gateway going down afterwards", async () => {
    // A CID names its bytes, so this is last-known-good that cannot be stale:
    // the content behind ipfs://QmCacheB can never become something else.
    stubFetch(() => okResponse("still-here"));
    await maybeFetchIpfs("ipfs://QmCacheB");
    stubFetch(() => {
        throw new Error("all gateways down");
    });
    assert.equal(await (await maybeFetchIpfs("ipfs://QmCacheB")).text(), "still-here");
});

test("a failure is never cached, so the gateway fallback stays alive", async () => {
    // Guard, not evidence: this passes before and after the cache exists. It is
    // here because caching failures is the tempting mistake that would turn one
    // bad moment into a dead image for the rest of the session.
    stubFetch(() => {
        throw new Error("down");
    });
    await assert.rejects(() => maybeFetchIpfs("ipfs://QmCacheC"));
    stubFetch(() => okResponse("recovered later"));
    assert.equal(await (await maybeFetchIpfs("ipfs://QmCacheC")).text(), "recovered later");
});

test("images are not retained, so a grid of large pictures cannot fill the tab", async () => {
    // Guard, not evidence: also passes before the cache exists. It pins the
    // deliberate exclusion, which is decided from the content type before the
    // body is buffered.
    stubFetch(() => okResponse("png-bytes", { "content-type": "image/png" }));
    await maybeFetchIpfs("ipfs://QmCacheImage");
    stubFetch(() => {
        throw new Error("down");
    });
    await assert.rejects(() => maybeFetchIpfs("ipfs://QmCacheImage"));
});

// --- a 200 that is not the payload ------------------------------------------

test("a gateway that answers 200 with something else falls through to the next", async () => {
    // Gateways serve HTML error pages and interstitials with a 200. The loop
    // used to stop at the first HTTP success, so the caller then failed to
    // parse it OUTSIDE the loop and the remaining gateways were never tried.
    const calls = stubFetch((url) =>
        url.startsWith(config.ipfsGateways[0])
            ? okResponse("<html>rate limited</html>", { "content-type": "text/html" })
            : okResponse('{"name":"real"}', { "content-type": "application/json" })
    );

    const res = await maybeFetchIpfs("ipfs://QmInterstitial", {
        validate: async (response) => {
            const body = await response.json();
            if (!body || typeof body !== "object") throw new Error("not metadata");
        },
    });

    assert.deepEqual(await res.json(), { name: "real" });
    assert.equal(calls.length, 2, "the second gateway must be tried");
});

test("a rejected body is not cached, so a later read is not stuck with it", async () => {
    // Only successes are cached; a validated-away answer must not be one.
    let served = 0;
    stubFetch((url) => {
        served += 1;
        return url.startsWith(config.ipfsGateways[0])
            ? okResponse("<html>nope</html>")
            : okResponse('{"name":"real"}');
    });
    const validate = async (response) => {
        JSON.parse(await response.text());
    };

    await maybeFetchIpfs("ipfs://QmNotCached", { validate });
    const before = served;
    // The good answer IS cached, so no gateway is asked again.
    assert.deepEqual(await (await maybeFetchIpfs("ipfs://QmNotCached", { validate })).json(), {
        name: "real",
    });
    assert.equal(served, before, "a validated answer is cached like any other");
    assert.equal(before, 2, "anti-vacuity: the bad gateway was actually tried");
});
