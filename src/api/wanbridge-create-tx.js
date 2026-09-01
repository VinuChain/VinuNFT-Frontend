import { ethers } from "ethers";
import { fetchWanBridgeJson, WANBRIDGE_PARTNER } from "../common/wanbridge";
import { applyApiRateLimit, parseBody, sendJson } from "../common/apiRateLimit";
import {
    isDestinationAccount,
    isEvmWanBridgeChain,
    isPositiveDecimal,
    isTokenIdentifier,
} from "../common/wanbridgeValidation";

// Upstream `error` text is third-party copy that the page renders.
const UPSTREAM_ERROR_MAX = 200;

function requireString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendJson(res, 405, { message: "Method not allowed" });
    }

    if (
        !applyApiRateLimit(req, res, {
            keyPrefix: "wanbridge-create-tx",
            limit: 30,
            windowMs: 60 * 1000,
        })
    ) {
        return sendJson(res, 429, {
            message: "Too many WanBridge transaction requests",
        });
    }

    // parseBody returns null on a body it cannot parse; unguarded it threw out
    // of the handler and a malformed request became a 500 instead of a 400.
    const body = parseBody(req);
    if (!body) {
        return sendJson(res, 400, { message: "Malformed request body" });
    }

    const payload = {
        fromChain: requireString(body.fromChain),
        toChain: requireString(body.toChain),
        fromToken: requireString(body.fromToken),
        toToken: requireString(body.toToken),
        fromAccount: requireString(body.fromAccount),
        toAccount: requireString(body.toAccount),
        amount: requireString(body.amount),
        partner: WANBRIDGE_PARTNER,
    };

    if (Object.values(payload).some((value) => !value)) {
        return sendJson(res, 400, {
            message: "Missing WanBridge transaction fields",
        });
    }

    // The source chain has to be one this app can actually build and sign an
    // EVM transaction for, not merely something shaped like a chain code. The
    // destination is enforced by isDestinationAccount below, which now fails
    // closed on any chain whose account format is unknown.
    if (!isEvmWanBridgeChain(payload.fromChain)) {
        return sendJson(res, 400, {
            message: "Unsupported WanBridge source chain",
        });
    }

    if (!ethers.utils.isAddress(payload.fromAccount)) {
        return sendJson(res, 400, {
            message: "Invalid source wallet address",
        });
    }

    if (!isDestinationAccount(payload.toAccount, payload.toChain)) {
        return sendJson(res, 400, {
            message: "Invalid destination account",
        });
    }

    if (
        !isTokenIdentifier(payload.fromToken, payload.fromChain) ||
        !isTokenIdentifier(payload.toToken, payload.toChain)
    ) {
        return sendJson(res, 400, {
            message: "Invalid WanBridge token identifier",
        });
    }

    if (!isPositiveDecimal(payload.amount)) {
        return sendJson(res, 400, { message: "Invalid bridge amount" });
    }

    try {
        const upstream = await fetchWanBridgeJson("createTx2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!upstream.ok) {
            // Never forward an upstream error body: it echoes this request's
            // own fields back at the browser and can carry arbitrary text.
            return sendJson(res, 502, {
                message: "WanBridge transaction upstream error",
            });
        }

        if (!upstream.payload.success) {
            return sendJson(res, 200, {
                success: false,
                error: String(
                    upstream.payload.error ||
                        "WanBridge returned no transaction"
                ).slice(0, UPSTREAM_ERROR_MAX),
            });
        }

        return sendJson(res, 200, upstream.payload);
    } catch (error) {
        return sendJson(res, 502, {
            message: "Could not create WanBridge transaction",
        });
    }
}
