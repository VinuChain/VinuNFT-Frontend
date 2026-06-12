import { ethers } from "ethers";
import { WANBRIDGE_API_BASE, WANBRIDGE_PARTNER } from "../common/wanbridge";
import { applyApiRateLimit, parseBody, sendJson } from "../common/apiRateLimit";
import {
    isChainType,
    isDestinationAccount,
    isPositiveDecimal,
    isTokenIdentifier,
} from "../common/wanbridgeValidation";

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

    const body = parseBody(req);
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

    if (!isChainType(payload.fromChain) || !isChainType(payload.toChain)) {
        return sendJson(res, 400, {
            message: "Invalid WanBridge chain type",
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
        const upstream = await fetch(`${WANBRIDGE_API_BASE}/createTx2`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const response = await upstream.json();

        return sendJson(res, upstream.ok ? 200 : upstream.status, response);
    } catch (error) {
        return sendJson(res, 502, {
            message: error.message || "Could not create WanBridge transaction",
        });
    }
}
