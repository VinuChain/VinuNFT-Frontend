import { WANBRIDGE_API_BASE } from "../common/wanbridge";
import { applyApiRateLimit, sendJson } from "../common/apiRateLimit";

function requiredQuery(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export default async function handler(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return sendJson(res, 405, { message: "Method not allowed" });
    }

    if (
        !applyApiRateLimit(req, res, {
            keyPrefix: "wanbridge-quota",
            limit: 120,
            windowMs: 60 * 1000,
        })
    ) {
        return sendJson(res, 429, {
            message: "Too many WanBridge quota requests",
        });
    }

    const fromChainType = requiredQuery(req.query.fromChainType);
    const toChainType = requiredQuery(req.query.toChainType);
    const tokenPairID = requiredQuery(req.query.tokenPairID);
    const symbol = requiredQuery(req.query.symbol);

    if (!fromChainType || !toChainType || !tokenPairID || !symbol) {
        return sendJson(res, 400, {
            message: "Missing WanBridge quota parameters",
        });
    }

    const params = new URLSearchParams({
        fromChainType,
        toChainType,
        tokenPairID,
        symbol,
    });

    try {
        const upstream = await fetch(
            `${WANBRIDGE_API_BASE}/quotaAndFee?${params.toString()}`
        );
        const payload = await upstream.json();

        if (upstream.ok && payload.success) {
            res.setHeader(
                "Cache-Control",
                "public, s-maxage=30, stale-while-revalidate=120"
            );
        }

        return sendJson(res, upstream.ok ? 200 : upstream.status, payload);
    } catch (error) {
        return sendJson(res, 502, {
            message: error.message || "Could not load WanBridge quota",
        });
    }
}
