import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ethers } from "ethers";

// Set before the handler is imported: it reads its limits at module load.
process.env.PINATA_MAX_UPLOADS_PER_WINDOW = "1";
process.env.PINATA_MAX_GLOBAL_UPLOADS_PER_WINDOW = "50";
process.env.UPLOAD_RATE_LIMIT_TIMEOUT_MS = "50";
process.env.VERCEL = "1";

const STORE_URL = "https://fake-store.example";

const { consumeRateLimit, RateLimitStoreError } = await import(
    "../src/common/uploadRateLimit.js"
);
const { default: handler } = await import("../src/api/upload-ipfs.js");
const { createUploadMessage, uploadPayloadDigest } = await import(
    "../src/common/uploadIntent.js"
);

/**
 * A fake Upstash: a Map plus the two commands the limiter sends. It awaits
 * between reading and writing a counter on purpose — any limiter that reads,
 * decides, then writes will interleave here and undercount.
 */
function fakeStore() {
    const keys = new Map();
    const store = {
        keys,
        calls: 0,
        async fetch(url, init) {
            store.calls += 1;
            assert.ok(String(url).startsWith(STORE_URL));
            assert.equal(init.headers.Authorization, "Bearer fake-store-token");

            const commands = JSON.parse(init.body);
            const results = [];
            // Each command applies without yielding, as Redis does. The await
            // is the transport, after the fact: a limiter that reads, decides
            // and writes back over two round trips interleaves there and
            // undercounts, while INCR cannot.
            for (const [name, key, value] of commands) {
                if (name === "INCR") {
                    const count = (keys.get(key) || 0) + 1;
                    keys.set(key, count);
                    results.push({ result: count });
                } else if (name === "PEXPIRE") {
                    assert.ok(Number(value) > 0);
                    results.push({ result: 1 });
                } else {
                    throw new Error(`unexpected command ${name}`);
                }
            }

            await sleep(0);
            return jsonResponse(200, results);
        },
    };

    return store;
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function useFetch(fn) {
    globalThis.fetch = fn;
}

async function withEnv(overrides, run) {
    const previous = {};
    for (const [name, value] of Object.entries(overrides)) {
        previous[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }

    try {
        return await run();
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

function configuredStore(store) {
    useFetch(store.fetch);
    return {
        UPSTASH_REDIS_REST_URL: STORE_URL,
        UPSTASH_REDIS_REST_TOKEN: "fake-store-token",
    };
}

test("a bucket refuses past its limit and the next window starts clean", async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        const windowMs = 300;
        const buckets = [{ key: "wallet:a", limit: 2 }];

        // Start at a window boundary, or the three calls below can straddle two
        // windows and the third is legitimately allowed.
        await sleep(windowMs - (Date.now() % windowMs));

        assert.equal(await consumeRateLimit(buckets, windowMs), null);
        assert.equal(await consumeRateLimit(buckets, windowMs), null);
        assert.equal(await consumeRateLimit(buckets, windowMs), "wallet:a");

        await sleep(windowMs);
        assert.equal(
            await consumeRateLimit(buckets, windowMs),
            null,
            "the window must reset rather than block forever"
        );
    });
});

test("the global bucket refuses while the per-wallet bucket still has room", async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        const buckets = [
            { key: "wallet:b", limit: 100 },
            { key: "global", limit: 1 },
        ];

        assert.equal(await consumeRateLimit(buckets, 60000), null);
        assert.equal(await consumeRateLimit(buckets, 60000), "global");
    });
});

test("the per-IP bucket refuses two different wallets behind one address", async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        const shared = { key: "ip:shared", limit: 1 };

        assert.equal(
            await consumeRateLimit(
                [{ key: "wallet:c", limit: 100 }, shared],
                60000
            ),
            null
        );
        assert.equal(
            await consumeRateLimit(
                [{ key: "wallet:d", limit: 100 }, shared],
                60000
            ),
            "ip:shared"
        );
    });
});

test("concurrent consumers cannot exceed the limit", async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        const buckets = [{ key: "wallet:e", limit: 5 }];
        const outcomes = await Promise.all(
            Array.from({ length: 20 }, () => consumeRateLimit(buckets, 60000))
        );

        assert.equal(
            outcomes.filter((outcome) => outcome === null).length,
            5,
            "an atomic increment must admit exactly the limit under a race"
        );
        assert.equal(
            [...store.keys.values()].every((count) => count === 20),
            true,
            "no increment may be lost"
        );
    });
});

test("an unreachable store refuses the request", async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        useFetch(async () => {
            throw new TypeError("fetch failed");
        });

        await assert.rejects(
            consumeRateLimit([{ key: "wallet:f", limit: 5 }], 60000),
            RateLimitStoreError
        );
    });
});

test("a rejected store token refuses the request", async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        useFetch(async () => jsonResponse(401, { error: "unauthorized" }));

        await assert.rejects(
            consumeRateLimit([{ key: "wallet:g", limit: 5 }], 60000),
            RateLimitStoreError
        );
    });
});

test("a store answer that is not a usable count refuses the request", async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        useFetch(async () => ({
            ok: true,
            status: 200,
            json: async () => [{ result: "not-a-number" }, { result: 1 }],
        }));

        await assert.rejects(
            consumeRateLimit([{ key: "wallet:h", limit: 5 }], 60000),
            RateLimitStoreError
        );

        useFetch(async () => ({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError("not json");
            },
        }));

        await assert.rejects(
            consumeRateLimit([{ key: "wallet:h", limit: 5 }], 60000),
            RateLimitStoreError
        );
    });
});

test("a hung store refuses the request instead of eating the invocation", { timeout: 5000 }, async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        // Settles only when the caller aborts. A store call with no abort
        // signal therefore never returns, which is what burns a serverless
        // invocation's whole duration budget and turns a refusal into a 504.
        useFetch(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () =>
                        reject(init.signal.reason)
                    );
                })
        );

        // Raced against a real timer for two reasons: AbortSignal.timeout's
        // own timer does not hold the event loop open, and a limiter that
        // never aborts must fail here rather than hang the suite.
        const outcome = await Promise.race([
            consumeRateLimit([{ key: "wallet:i", limit: 5 }], 60000).then(
                (allowed) => allowed,
                (error) => error
            ),
            sleep(1500, "still waiting on the store"),
        ]);

        assert.ok(
            outcome instanceof RateLimitStoreError,
            `the store call must abort on its own timeout, got ${outcome}`
        );
    });
});

test("a deployment with no store configured refuses rather than falling back", async () => {
    await withEnv(
        {
            UPSTASH_REDIS_REST_URL: undefined,
            UPSTASH_REDIS_REST_TOKEN: undefined,
            VERCEL: "1",
        },
        async () => {
            await assert.rejects(
                consumeRateLimit([{ key: "wallet:j", limit: 5 }], 60000),
                RateLimitStoreError
            );
        }
    );
});

test("the in-memory fallback is only reachable outside a deployment", async () => {
    await withEnv(
        {
            UPSTASH_REDIS_REST_URL: undefined,
            UPSTASH_REDIS_REST_TOKEN: undefined,
            VERCEL: undefined,
        },
        async () => {
            const buckets = [{ key: "wallet:k", limit: 1 }];

            assert.equal(await consumeRateLimit(buckets, 60000), null);
            assert.equal(await consumeRateLimit(buckets, 60000), "wallet:k");
        }
    );
});

// --- endpoint level -------------------------------------------------------

const UPLOAD_ACTION = { file: "mint-image", json: "mint-metadata" };

function digested({ auth, ...rest }) {
    return rest;
}

function jsonPayload(auth) {
    return { type: "json", auth, metadata: { name: "Rate Limit Test" } };
}

async function signedAuth(wallet) {
    const issuedAt = new Date().toISOString();
    const payload = jsonPayload(null);

    return {
        address: wallet.address,
        issuedAt,
        signature: await wallet.signMessage(
            createUploadMessage({
                address: ethers.utils.getAddress(wallet.address),
                issuedAt,
                chainId: 207,
                action: UPLOAD_ACTION[payload.type],
                digest: uploadPayloadDigest(digested(payload)),
            })
        ),
    };
}

function request(body, forwardedFor) {
    return {
        method: "POST",
        headers: { "x-forwarded-for": forwardedFor },
        socket: { remoteAddress: "10.0.0.1" },
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

/** Route store traffic to the fake and everything else to a Pinata success. */
function storeAndPinata(store) {
    return async (url, init) =>
        String(url).startsWith(STORE_URL)
            ? store.fetch(url, init)
            : { ok: true, status: 200, text: async () => '{"IpfsHash":"Qm1"}' };
}

async function silently(run) {
    const info = console.info;
    const warn = console.warn;
    console.info = () => {};
    console.warn = () => {};
    try {
        return await run();
    } finally {
        console.info = info;
        console.warn = warn;
    }
}

test("the endpoint refuses an upload the store reports as over limit", async () => {
    const wallet = ethers.Wallet.createRandom();
    process.env.PINATA_API_JWT = "unused-in-this-test";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = wallet.address;

    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        useFetch(storeAndPinata(store));

        const first = response();
        const second = response();
        await silently(async () => {
            await handler(
                request(jsonPayload(await signedAuth(wallet)), "198.51.100.7"),
                first
            );
            await handler(
                request(jsonPayload(await signedAuth(wallet)), "198.51.100.7"),
                second
            );
        });

        assert.equal(first.statusCode, 200);
        // An unawaited async limiter would let this through with a 200.
        assert.equal(second.statusCode, 400);
        assert.equal(
            JSON.parse(second.body).error,
            "Upload rate limit exceeded."
        );
    });
});

test("the endpoint refuses an upload when the store cannot answer", async () => {
    const wallet = ethers.Wallet.createRandom();
    process.env.PINATA_API_JWT = "unused-in-this-test";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = wallet.address;

    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        let pinataCalls = 0;
        useFetch(async (url) => {
            if (String(url).startsWith(STORE_URL)) {
                throw new TypeError("fetch failed");
            }
            pinataCalls += 1;
            return { ok: true, status: 200, text: async () => "{}" };
        });

        const res = response();
        const events = [];
        const warn = console.warn;
        console.warn = (line) => events.push(JSON.parse(line));
        try {
            await handler(
                request(jsonPayload(await signedAuth(wallet)), "198.51.100.8"),
                res
            );
        } finally {
            console.warn = warn;
        }

        assert.equal(res.statusCode, 400);
        assert.equal(pinataCalls, 0, "a fail-closed limiter must not pin");
        assert.equal(events[0].reason, "rate_limit_store_unavailable");
    });
});

test("per-IP buckets separate clients behind the platform proxy", async () => {
    const walletA = ethers.Wallet.createRandom();
    const walletB = ethers.Wallet.createRandom();
    process.env.PINATA_API_JWT = "unused-in-this-test";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = `${walletA.address},${walletB.address}`;

    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        useFetch(storeAndPinata(store));

        const first = response();
        const second = response();
        await silently(async () => {
            await handler(
                request(jsonPayload(await signedAuth(walletA)), "203.0.113.1"),
                first
            );
            await handler(
                request(jsonPayload(await signedAuth(walletB)), "203.0.113.2"),
                second
            );
        });

        assert.equal(first.statusCode, 200);
        // Keyed on req.socket.remoteAddress these two share one bucket, and
        // the platform proxy makes that the same address for every visitor.
        assert.equal(second.statusCode, 200);
    });
});

test("upload counts live in the shared store, not in process memory", async () => {
    const wallet = ethers.Wallet.createRandom();
    process.env.PINATA_API_JWT = "unused-in-this-test";
    process.env.PINATA_ALLOWED_UPLOAD_ADDRESSES = wallet.address;

    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        useFetch(storeAndPinata(store));

        await silently(async () => {
            await handler(
                request(jsonPayload(await signedAuth(wallet)), "198.51.100.9"),
                response()
            );
            await handler(
                request(jsonPayload(await signedAuth(wallet)), "198.51.100.9"),
                response()
            );
        });

        // The counters a cold start would have lost. A process-memory limiter
        // never touches the store at all, which is exactly why a fresh Vercel
        // instance starts every visitor's quota again from zero.
        assert.equal(store.calls, 2);
        const counts = [...store.keys.entries()];
        assert.equal(counts.length, 3, "wallet, IP and global are all durable");
        assert.equal(
            counts.every(([, count]) => count === 2),
            true,
            JSON.stringify(counts)
        );
        assert.equal(
            counts.some(([key]) => key.includes("global")),
            true
        );
    });
});

test("preview and production do not share a window", async () => {
    const store = fakeStore();
    await withEnv(configuredStore(store), async () => {
        const buckets = [{ key: "global", limit: 1 }];

        await withEnv({ VERCEL_ENV: "production" }, async () => {
            assert.equal(await consumeRateLimit(buckets, 60000), null);
        });
        await withEnv({ VERCEL_ENV: "preview" }, async () => {
            assert.equal(
                await consumeRateLimit(buckets, 60000),
                null,
                "a preview deployment must not spend production's quota"
            );
        });
        await withEnv({ VERCEL_ENV: "preview" }, async () => {
            assert.equal(await consumeRateLimit(buckets, 60000), "global");
        });
    });
});
