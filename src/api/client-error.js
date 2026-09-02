import { applyApiRateLimit, parseBody, sendJson } from "../common/apiRateLimit";

const CLIENT_ERROR_EVENT = "vinunft.client_error";
const MAX_FIELD_LENGTH = 300;

// ponytail: in-memory limiter, unlike the upload endpoint. This one only
// guards the platform log against a burst from one warm instance; paying an
// Upstash round trip per client error buys nothing an attacker cares about,
// since the endpoint stores nothing and reaches no third party.
const RATE_LIMIT = { keyPrefix: "client-error", windowMs: 60_000, limit: 20 };

export const config = {
    bodyParser: {
        json: {
            limit: "8kb",
        },
    },
};

/** Bounded, and never the query string: it can carry addresses or tokens. */
function boundedPath(value) {
    if (typeof value !== "string") {
        return null;
    }

    try {
        return new URL(value).pathname.slice(0, MAX_FIELD_LENGTH);
    } catch {
        return value.split("?")[0].slice(0, MAX_FIELD_LENGTH);
    }
}

function boundedText(value) {
    return typeof value === "string" ? value.slice(0, MAX_FIELD_LENGTH) : null;
}

/**
 * Records a browser error to the platform log.
 *
 * This is a log line, not an error tracker: retention is whatever the Vercel
 * plan gives runtime logs, and nothing here pages anyone. See README for what
 * that does and does not buy.
 */
export default function handler(req, res) {
    if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Method not allowed" });
    }

    if (!applyApiRateLimit(req, res, RATE_LIMIT)) {
        return sendJson(res, 429, { error: "Too many error reports." });
    }

    const payload = parseBody(req);
    if (!payload) {
        return sendJson(res, 400, { error: "Malformed request body." });
    }

    console.error(
        JSON.stringify({
            event: CLIENT_ERROR_EVENT,
            kind:
                payload.kind === "unhandledrejection" ? payload.kind : "error",
            message: boundedText(payload.message),
            source: boundedPath(payload.source),
            path: boundedPath(payload.path),
            stack: boundedText(payload.stack),
            release: process.env.VERCEL_GIT_COMMIT_SHA || null,
            userAgent: boundedText(req.headers["user-agent"]),
            recordedAt: new Date().toISOString(),
        })
    );

    res.status(204);
    return res.send("");
}
