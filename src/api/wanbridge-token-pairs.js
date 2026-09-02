import {
    buildVinuChainRoutes,
    fetchWanBridgeJson,
    VINUCHAIN_CHAIN_TYPE,
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
        throw new Error("WanBridge tokenPairs failed");
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
                cause: error?.message ?? String(error),
            })
        );
        return sendJson(res, 502, {
            message: "Could not load WanBridge pairs",
        });
    }
}
