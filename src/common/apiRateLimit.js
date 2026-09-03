const buckets = new Map();

function firstHeader(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.split(",")[0]?.trim() || null;
}

function lastForwardedFor(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    const parts = raw
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    return parts?.[parts.length - 1] || null;
}

function isPrivateOrLoopbackAddress(value) {
    if (value.startsWith("::ffff:")) {
        return isPrivateOrLoopbackAddress(value.slice("::ffff:".length));
    }

    const parts = value.split(".").map((part) => Number(part));
    const isIpv4 =
        parts.length === 4 && parts.every((part) => Number.isInteger(part));

    return (
        value === "127.0.0.1" ||
        value === "::1" ||
        value.startsWith("fc") ||
        value.startsWith("fd") ||
        (isIpv4 &&
            (parts[0] === 10 ||
                parts[0] === 127 ||
                (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
                (parts[0] === 192 && parts[1] === 168)))
    );
}

/**
 * A stable per-client bucket key.
 *
 * Exported because the IPFS upload endpoint needs the same answer: behind
 * Vercel's proxy `req.socket.remoteAddress` is the proxy itself and identical
 * for every request, so a per-IP limit keyed on it is one shared global bucket.
 */
export function clientKey(req) {
    const trustedHeader = process.env.TRUSTED_CLIENT_IP_HEADER?.toLowerCase();
    if (trustedHeader) {
        const trustedIp = firstHeader(req.headers[trustedHeader]);
        if (trustedIp) {
            return `trusted:${trustedHeader}:${trustedIp}`;
        }
    }

    if (process.env.VERCEL) {
        const forwardedFor = firstHeader(req.headers["x-forwarded-for"]);
        if (forwardedFor) {
            return `vercel:${forwardedFor}`;
        }
    }

    const socketAddress = req.socket?.remoteAddress || "";
    const forwardedFor = lastForwardedFor(req.headers["x-forwarded-for"]);

    if (isPrivateOrLoopbackAddress(socketAddress) && forwardedFor) {
        return `proxy:${socketAddress}:${forwardedFor}`;
    }

    return `socket:${socketAddress || "unknown"}`;
}

function pruneExpiredBuckets(now) {
    if (buckets.size < 500) {
        return;
    }

    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
            buckets.delete(key);
        }
    }
}

export function applyApiRateLimit(req, res, options) {
    const now = Date.now();
    pruneExpiredBuckets(now);

    const key = `${options.keyPrefix}:${clientKey(req)}`;
    const bucket = buckets.get(key);
    const activeBucket =
        bucket && bucket.resetAt > now
            ? bucket
            : { count: 0, resetAt: now + options.windowMs };

    activeBucket.count += 1;
    buckets.set(key, activeBucket);

    const remaining = Math.max(0, options.limit - activeBucket.count);
    res.setHeader("X-RateLimit-Limit", String(options.limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader(
        "X-RateLimit-Reset",
        String(Math.ceil(activeBucket.resetAt / 1000))
    );

    return activeBucket.count <= options.limit;
}

/**
 * The request body as an object, or null if it is not parseable.
 *
 * Returning null rather than throwing is the point: a host that hands the
 * handler a raw string body puts the parse before any try block a caller has
 * opened, so an unguarded JSON.parse turns a malformed request into a 500 from
 * outside the handler instead of the 400 every other bad input gets. Callers
 * must treat null as a 400.
 */
export function parseBody(req) {
    if (typeof req.body === "string") {
        try {
            return JSON.parse(req.body);
        } catch (error) {
            return null;
        }
    }

    return req.body || {};
}

export function sendJson(res, statusCode, body) {
    res.status(statusCode);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(body));
}
