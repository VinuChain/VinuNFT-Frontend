/**
 * Durable rate limiting for the IPFS upload endpoint.
 *
 * The previous limiter was a process-memory Map. On Vercel every invocation may
 * be a fresh instance, so that Map is empty on most requests and shared with
 * nobody: it is a burst guard for one warm container, not a limit.
 *
 * Counting is a fixed window per bucket, incremented with Redis `INCR` over
 * Upstash's HTTPS REST API. `INCR` is the point: a read-then-write loses
 * increments whenever two invocations race, and returns a count no caller can
 * trust. The window index is baked into the key, so the TTL is only garbage
 * collection and never has to be set conditionally.
 *
 * ponytail: fixed windows, so up to 2x the limit can land across a window
 * boundary. A sliding log would need a sorted set and two round trips; revisit
 * if boundary bursts ever matter more than the extra call.
 */

const DEFAULT_STORE_TIMEOUT_MS = 2000;

/** Store unreachable, refusing the request, distinct from being over quota. */
export class RateLimitStoreError extends Error {
    constructor(message) {
        super(message);
        this.name = "RateLimitStoreError";
    }
}

// Local development only. Never selected when VERCEL is set; see selectStore.
const memoryCounters = new Map();

function memoryIncrement(windowKey, expiresAt) {
    if (memoryCounters.size > 500) {
        const now = Date.now();
        for (const [key, entry] of memoryCounters) {
            if (entry.expiresAt <= now) memoryCounters.delete(key);
        }
    }

    const count = (memoryCounters.get(windowKey)?.count || 0) + 1;
    memoryCounters.set(windowKey, { count, expiresAt });
    return count;
}

function storeTimeoutMs() {
    return (
        Number(process.env.UPLOAD_RATE_LIMIT_TIMEOUT_MS) ||
        DEFAULT_STORE_TIMEOUT_MS
    );
}

/**
 * One pipelined round trip: INCR + PEXPIRE for every bucket. A hung store must
 * not eat the function's whole duration budget, or a refusal that should be a
 * clean 400 becomes a platform timeout — which is failing open by another name.
 */
async function upstashIncrement(url, token, commands) {
    let response;
    try {
        response = await fetch(`${url.replace(/\/+$/, "")}/pipeline`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(commands),
            signal: AbortSignal.timeout(storeTimeoutMs()),
        });
    } catch (error) {
        throw new RateLimitStoreError("rate limit store is unreachable");
    }

    if (!response.ok) {
        // A rotated or wrong token is a 401 here. It must refuse uploads, not
        // wave them through.
        throw new RateLimitStoreError(
            `rate limit store returned ${response.status}`
        );
    }

    let results;
    try {
        results = await response.json();
    } catch (error) {
        throw new RateLimitStoreError("rate limit store returned no JSON");
    }

    if (!Array.isArray(results) || results.length !== commands.length) {
        throw new RateLimitStoreError(
            "rate limit store returned an unexpected pipeline result"
        );
    }

    return results.map((entry) => {
        if (entry?.error) {
            throw new RateLimitStoreError(
                "rate limit store rejected a command"
            );
        }
        return entry?.result;
    });
}

function selectStore() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    return url && token
        ? (commands) => upstashIncrement(url, token, commands)
        : null;
}

/**
 * Consume one slot in every bucket.
 *
 * `buckets` is `[{ key, limit }]`. Returns the key of the first bucket that is
 * over its limit, or null when the request is within all of them.
 *
 * Every bucket is incremented even when one of them refuses. That is the cost
 * of a single round trip, and it means a refused request still spends global
 * quota. It is bounded today because the endpoint checks its upload allowlist
 * before it gets here, so only an allowlisted wallet can spend it; that
 * ordering has to hold if the allowlist is ever widened.
 *
 * Throws RateLimitStoreError when the store cannot answer. Callers must refuse
 * the request: an unanswerable limit is not an absent limit.
 */
export async function consumeRateLimit(buckets, windowMs) {
    const windowIndex = Math.floor(Date.now() / windowMs);
    // Namespaced by deployment environment: preview deployments share the
    // store with production, and without this a wallet testing uploads on a
    // pull request would spend production's global window.
    const namespace = process.env.VERCEL_ENV || "development";
    const windowKeys = buckets.map(
        (bucket) =>
            `vinunft:ratelimit:${namespace}:${bucket.key}:${windowIndex}`
    );
    const store = selectStore();
    let counts;

    if (store) {
        const commands = windowKeys.flatMap((key) => [
            ["INCR", key],
            ["PEXPIRE", key, windowMs * 2],
        ]);
        const results = await store(commands);
        counts = windowKeys.map((_key, index) => Number(results[index * 2]));
    } else if (process.env.VERCEL) {
        // VERCEL is set on every Vercel build and invocation, preview
        // included, so a deployment that forgot to configure a store refuses
        // uploads rather than dropping to the in-memory fallback below.
        throw new RateLimitStoreError(
            "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not configured"
        );
    } else {
        // Local development fallback, deliberately process-memory. Unreachable
        // in any deployment: the VERCEL branch above refuses first.
        const expiresAt = (windowIndex + 2) * windowMs;
        counts = windowKeys.map((key) => memoryIncrement(key, expiresAt));
    }

    for (const [index, bucket] of buckets.entries()) {
        if (!Number.isFinite(counts[index])) {
            throw new RateLimitStoreError(
                "rate limit store returned a non-numeric count"
            );
        }
        if (counts[index] > bucket.limit) {
            return bucket.key;
        }
    }

    return null;
}
