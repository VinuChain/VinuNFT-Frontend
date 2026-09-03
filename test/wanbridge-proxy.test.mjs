import assert from "node:assert/strict";
import test from "node:test";

/**
 * The three WanBridge proxies are the only place this app makes an outbound
 * request on an anonymous caller's behalf. They are tested the way
 * test/upload-ipfs-audit.test.mjs tests its handler: import the default export,
 * drive a fake req/res, and stub globalThis.fetch so the assertion is about
 * what the handler asked for, not about a third party being up.
 */

const { default: quotaHandler } = await import(
    "../src/api/wanbridge-quota-and-fee.js"
);
const { default: createTxHandler } = await import(
    "../src/api/wanbridge-create-tx.js"
);
const { default: tokenPairsHandler } = await import(
    "../src/api/wanbridge-token-pairs.js"
);

const VALID_ADDRESS = "0x12BD0b15D5010De455DCe7944265Fe1D35a84023";

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

/** A distinct remote address per test keeps the shared rate-limit buckets apart. */
let ip = 0;
function request({ method = "GET", query = {}, body = undefined } = {}) {
    ip += 1;
    return {
        method,
        headers: {},
        socket: { remoteAddress: `203.0.113.${ip % 250}` },
        query,
        body,
    };
}

/**
 * Records every call and answers with a fixed JSON body.
 * `headers` lets a test claim a response size it never has to produce.
 */
function stubFetch({ payload = { success: true, data: {} }, ok = true, status = 200, contentLength = null } = {}) {
    const calls = [];
    globalThis.fetch = (url, init) => {
        calls.push({ url: String(url), init });
        const text = JSON.stringify(payload);
        return Promise.resolve({
            ok,
            status,
            headers: {
                get: (name) =>
                    name.toLowerCase() === "content-length"
                        ? contentLength
                        : null,
            },
            text: async () => text,
            json: async () => payload,
        });
    };
    return calls;
}

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

const VALID_QUOTA_QUERY = {
    fromChainType: "VC",
    toChainType: "BNB",
    tokenPairID: "536",
    symbol: "USDT",
};

test("the quota proxy bounds its upstream call with a timeout signal", async () => {
    const calls = stubFetch();
    const res = response();
    await quotaHandler(request({ query: VALID_QUOTA_QUERY }), res);

    assert.equal(calls.length, 1);
    assert.ok(
        calls[0].init?.signal instanceof AbortSignal,
        "a hung upstream must abort, not hold the invocation to the platform ceiling"
    );
});

test("the quota proxy refuses an upstream response larger than its cap", async () => {
    stubFetch({ contentLength: "52428800" });
    const res = response();
    await quotaHandler(request({ query: VALID_QUOTA_QUERY }), res);

    assert.equal(res.statusCode, 502);
});

test("the quota proxy rejects unbounded and malformed parameters without calling upstream", async () => {
    const calls = stubFetch();
    const res = response();
    await quotaHandler(
        request({
            query: {
                ...VALID_QUOTA_QUERY,
                tokenPairID: "../../admin",
                symbol: "S".repeat(5000),
            },
        }),
        res
    );

    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
});

test("the quota proxy does not echo an upstream error body", async () => {
    stubFetch({
        ok: false,
        status: 500,
        payload: { error: "[iWan] internal detail nobody outside should read" },
    });
    const res = response();
    await quotaHandler(request({ query: VALID_QUOTA_QUERY }), res);

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.includes("iWan"), false);
});

const VALID_CREATE_BODY = {
    fromChain: "VC",
    toChain: "BNB",
    fromToken: VALID_ADDRESS,
    toToken: VALID_ADDRESS,
    fromAccount: VALID_ADDRESS,
    toAccount: VALID_ADDRESS,
    amount: "5",
};

test("create-tx refuses a source chain the app cannot sign for", async () => {
    const calls = stubFetch();
    const res = response();
    await createTxHandler(
        request({
            method: "POST",
            body: { ...VALID_CREATE_BODY, fromChain: "BTC" },
        }),
        res
    );

    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
});

test("create-tx refuses a destination chain whose account format is unknown", async () => {
    const calls = stubFetch();
    const res = response();
    await createTxHandler(
        request({
            method: "POST",
            // XPL (Plasma) is live in the WanBridge catalog and in neither of
            // the app's chain lists; this is a truncated EVM address.
            body: {
                ...VALID_CREATE_BODY,
                toChain: "XPL",
                toAccount: "0x12BD0b15D5010De455DCe7944265Fe1D35a840",
            },
        }),
        res
    );

    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
});

test("create-tx answers a malformed JSON body with 400, not a crash", async () => {
    stubFetch();
    const res = response();
    await createTxHandler(request({ method: "POST", body: "{" }), res);

    assert.equal(res.statusCode, 400);
});

test("create-tx bounds its upstream call and hides the upstream error body", async () => {
    const calls = stubFetch({
        ok: false,
        status: 500,
        payload: { error: "[iWan] internal detail nobody outside should read" },
    });
    const res = response();
    await createTxHandler(
        request({ method: "POST", body: VALID_CREATE_BODY }),
        res
    );

    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.includes("iWan"), false);
});

test("the token-pairs proxy bounds both of its upstream calls", async () => {
    // The only call to this handler in the file, so its five-minute module
    // cache is cold and the assertion cannot pass vacuously off a warm one.
    const calls = stubFetch({ payload: { success: true, data: [] } });
    const res = response();
    await tokenPairsHandler(request(), res);

    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.ok(
            call.init?.signal instanceof AbortSignal,
            `${call.url} must be bounded by a timeout`
        );
    }
});

// ---------------------------------------------------------------------------
// Upstream failures must name their cause
// ---------------------------------------------------------------------------

test("an upstream timeout is reported as a timeout, not as an opaque failure", async () => {
    const { fetchWanBridgeJson } = await import("../src/common/wanbridge.js");
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
    };
    try {
        await assert.rejects(
            () => fetchWanBridgeJson("tokenPairs"),
            (e) =>
                e.name === "WanBridgeUpstreamError" &&
                /timed out after \d+ms/.test(e.message) &&
                e.message.includes("tokenPairs")
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("a non-timeout upstream failure names its own cause", async () => {
    const { fetchWanBridgeJson } = await import("../src/common/wanbridge.js");
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        const e = new Error("getaddrinfo ENOTFOUND bridge-api.wanchain.org");
        e.name = "TypeError";
        throw e;
    };
    try {
        await assert.rejects(
            () => fetchWanBridgeJson("tokenPairs"),
            (e) => /ENOTFOUND/.test(e.message)
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("each proxy logs the cause of a 502 instead of swallowing it", async () => {
    // The production outage on token-pairs could not be diagnosed remotely
    // because the catch discarded the error entirely.
    const { readFileSync } = await import("node:fs");
    for (const route of ["token-pairs", "quota-and-fee", "create-tx"]) {
        const src = readFileSync(`src/api/wanbridge-${route}.js`, "utf8");
        assert.match(src, /vinunft\.wanbridge_proxy_failed/, route);
        assert.match(src, /cause: error\?\.message/, route);
    }
});
