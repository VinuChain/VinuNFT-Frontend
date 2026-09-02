import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("../src/common/apiRoute.js");
const { apiRoute, withTrailingSlash } = mod.default || mod;
const cfg = await import("../src/config.js");
const config = cfg.default || cfg;

// The deployment 308s `/api/x` to `/api/x/`. The redirect is harmless - 308
// keeps the method and body - but it is a wasted round trip on every upload
// and every bridge call, so the client requests the canonical form.

test("apiRoute returns the canonical trailing-slash path", () => {
    assert.equal(apiRoute("upload-ipfs"), "/api/upload-ipfs/");
    assert.equal(apiRoute("wanbridge-token-pairs"), "/api/wanbridge-token-pairs/");
});

test("apiRoute puts the query after the slash, not before it", () => {
    // `/api/x?q=1` would still be redirected; the slash has to precede the query.
    assert.equal(
        apiRoute("wanbridge-quota-and-fee", "fromChain=207&amount=1"),
        "/api/wanbridge-quota-and-fee/?fromChain=207&amount=1"
    );
});

test("apiRoute rejects a missing name rather than building /api//", () => {
    assert.throws(() => apiRoute(""), TypeError);
    assert.throws(() => apiRoute(undefined), TypeError);
});

test("withTrailingSlash leaves an already-canonical path alone", () => {
    assert.equal(withTrailingSlash("/api/x/"), "/api/x/");
    assert.equal(withTrailingSlash("/api/x/?a=1"), "/api/x/?a=1");
});

test("withTrailingSlash preserves query and fragment", () => {
    assert.equal(withTrailingSlash("/api/x?a=1"), "/api/x/?a=1");
    assert.equal(withTrailingSlash("/api/x#frag"), "/api/x/#frag");
});

test("withTrailingSlash handles an absolute override host", () => {
    // GATSBY_IPFS_UPLOAD_ENDPOINT may point at another host on a static deploy.
    assert.equal(
        withTrailingSlash("https://uploads.example/api/upload-ipfs"),
        "https://uploads.example/api/upload-ipfs/"
    );
});

test("withTrailingSlash passes through empty input untouched", () => {
    assert.equal(withTrailingSlash(""), "");
    assert.equal(withTrailingSlash(undefined), undefined);
});

test("the configured upload endpoint is canonical, so no upload pays a redirect", () => {
    assert.ok(
        config.ipfsUploadEndpoint.endsWith("/"),
        `ipfsUploadEndpoint must not trigger a 308: ${config.ipfsUploadEndpoint}`
    );
});
