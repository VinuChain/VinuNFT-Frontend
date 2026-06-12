import {
    buildVinuChainRoutes,
    WANBRIDGE_API_BASE,
    VINUCHAIN_CHAIN_TYPE,
} from "../common/wanbridge";
import { applyApiRateLimit, sendJson } from "../common/apiRateLimit";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedCatalog = null;

async function fetchJson(path) {
    const response = await fetch(`${WANBRIDGE_API_BASE}/${path}`);
    return await response.json();
}

async function getVinuChainCatalog() {
    const now = Date.now();
    if (cachedCatalog && cachedCatalog.expiresAt > now) {
        return cachedCatalog.value;
    }

    const [hashResponse, pairsResponse] = await Promise.all([
        fetchJson("tokenPairsHash"),
        fetchJson("tokenPairs"),
    ]);

    if (!pairsResponse.success) {
        throw new Error(pairsResponse.error || "WanBridge tokenPairs failed");
    }

    const pairs = pairsResponse.data.filter(
        (pair) =>
            pair.fromChain?.chainType === VINUCHAIN_CHAIN_TYPE ||
            pair.toChain?.chainType === VINUCHAIN_CHAIN_TYPE
    );

    const value = {
        hash: hashResponse.success ? hashResponse.data : null,
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
        return sendJson(res, 502, {
            message: error.message || "Could not load WanBridge pairs",
        });
    }
}
