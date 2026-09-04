import {
    buildVinuChainRoutes,
    fetchWanBridgeJson,
    VINUCHAIN_CHAIN_TYPE,
    WanBridgeUpstreamError,
    WANBRIDGE_FAILURE,
} from "../common/wanbridge";
import { applyApiRateLimit, sendJson } from "../common/apiRateLimit";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedCatalog = null;

async function getVinuChainCatalog() {
    const now = Date.now();
    if (cachedCatalog && cachedCatalog.expiresAt > now) {
        return cachedCatalog.value;
    }

    const [hashResponse, pairsResponse] = await Promise.all([
        fetchWanBridgeJson("tokenPairsHash"),
        fetchWanBridgeJson("tokenPairs"),
    ]);

    if (!pairsResponse.ok || !pairsResponse.payload.success) {
        throw new WanBridgeUpstreamError(
            `WanBridge tokenPairs returned ${pairsResponse.status} without success`,
            {
                reason: WANBRIDGE_FAILURE.STATUS,
                status: pairsResponse.status,
            }
        );
    }

    const pairs = pairsResponse.payload.data.filter(
        (pair) =>
            pair.fromChain?.chainType === VINUCHAIN_CHAIN_TYPE ||
            pair.toChain?.chainType === VINUCHAIN_CHAIN_TYPE
    );

    const value = {
        hash:
            hashResponse.ok && hashResponse.payload.success
                ? hashResponse.payload.data
                : null,
        fetchedAt: new Date().toISOString(),
        pairs,
        routes: buildVinuChainRoutes(pairs),
    };

    cachedCatalog = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        value,
    };

    return value;
}

/**
 * The last catalog this instance fetched, however old, or null.
 *
 * Held past its TTL on purpose: when a refresh fails, a bridge page that lists
 * the routes it listed a minute ago is worth more than a 502, and the pairs
 * themselves change rarely. It is returned marked `stale` with the time it was
 * fetched — never as if it were live — so the page can say so.
 */
function lastKnownCatalog() {
    return cachedCatalog ? cachedCatalog.value : null;
}

/** Test seam: the catalog is module state, so one test's success would
 *  otherwise be served as another test's stale fallback. */
export function _resetCatalogCache() {
    cachedCatalog = null;
}

export default async function handler(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return sendJson(res, 405, { message: "Method not allowed" });
    }

    if (
        !applyApiRateLimit(req, res, {
            keyPrefix: "wanbridge-token-pairs",
            limit: 120,
            windowMs: 60 * 1000,
        })
    ) {
        return sendJson(res, 429, {
            message: "Too many WanBridge catalog requests",
        });
    }

    try {
        const catalog = await getVinuChainCatalog();
        res.setHeader(
            "Cache-Control",
            "public, s-maxage=300, stale-while-revalidate=900"
        );
        return sendJson(res, 200, catalog);
    } catch (error) {
        // Fixed text to the browser: the caught error can carry the upstream
        // body, a DNS name or an AbortError, none of which it needs. The cause
        // goes to the server log instead - swallowing it entirely is what made
        // the production outage on this proxy impossible to diagnose remotely.
        console.warn(
            JSON.stringify({
                event: "vinunft.wanbridge_proxy_failed",
                route: "token-pairs",
                reason: error?.reason ?? "unknown",
                upstreamStatus: error?.status ?? null,
                cause: error?.message ?? String(error),
            })
        );

        // Serve the last catalog this instance fetched rather than nothing.
        // Explicitly marked stale with the time it was taken: the page must be
        // able to say the routes may have moved, and must never present this
        // as live. A cold instance has no catalog and still fails.
        const stale = lastKnownCatalog();
        if (stale) {
            res.setHeader("Cache-Control", "no-store");
            return sendJson(res, 200, {
                ...stale,
                stale: true,
                staleReason: error?.reason ?? "unknown",
            });
        }

        // `reason` is a fixed enum describing OUR call, not the upstream's
        // content, so it is safe to return and is what makes a live 502
        // diagnosable without shell access to the platform's logs.
        return sendJson(res, 502, {
            message: "Could not load WanBridge pairs",
            reason: error?.reason ?? "unknown",
            upstreamStatus: error?.status ?? null,
        });
    }
}
