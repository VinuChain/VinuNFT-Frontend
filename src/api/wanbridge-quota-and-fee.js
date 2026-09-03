import { fetchWanBridgeJson } from "../common/wanbridge";
import { applyApiRateLimit, sendJson } from "../common/apiRateLimit";
import { isChainType } from "../common/wanbridgeValidation";

// Every value below is interpolated into an upstream query string. Bounded
// shapes, not just non-empty strings: an unvalidated 5000-character symbol is
// an unbounded upstream call made on an anonymous request's say-so.
const TOKEN_PAIR_ID_RE = /^\d{1,10}$/;
const SYMBOL_RE = /^[A-Za-z0-9._-]{1,32}$/;

// Upstream `error` text is third-party copy that the page renders; keep the
// reason, drop the room to paste anything substantial into the UI.
const UPSTREAM_ERROR_MAX = 200;

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

    if (
        !isChainType(fromChainType) ||
        !isChainType(toChainType) ||
        !TOKEN_PAIR_ID_RE.test(tokenPairID || "") ||
        !SYMBOL_RE.test(symbol || "")
    ) {
        return sendJson(res, 400, {
            message: "Invalid WanBridge quota parameters",
        });
    }

    const params = new URLSearchParams({
        fromChainType,
        toChainType,
        tokenPairID,
        symbol,
    });

    try {
        const { ok, payload } = await fetchWanBridgeJson(
            `quotaAndFee?${params.toString()}`
        );

        if (!ok) {
            // Never forward an upstream error body: it is attacker-influencable
            // text reflected straight back at the browser.
            return sendJson(res, 502, {
                message: "WanBridge quota upstream error",
            });
        }

        if (!payload.success) {
            return sendJson(res, 200, {
                success: false,
                error: String(
                    payload.error || "WanBridge quota unavailable"
                ).slice(0, UPSTREAM_ERROR_MAX),
            });
        }

        res.setHeader(
            "Cache-Control",
            "public, s-maxage=30, stale-while-revalidate=120"
        );
        return sendJson(res, 200, payload);
    } catch (error) {
        // Fixed text to the browser: the caught error can carry the upstream
        // body, a DNS name or an AbortError, none of which it needs. The cause
        // goes to the server log instead - swallowing it entirely is what made
        // the production outage on this proxy impossible to diagnose remotely.
        console.warn(
            JSON.stringify({
                event: "vinunft.wanbridge_proxy_failed",
                route: "quota-and-fee",
                cause: error?.message ?? String(error),
            })
        );
        return sendJson(res, 502, {
            message: "Could not load WanBridge quota",
        });
    }
}
