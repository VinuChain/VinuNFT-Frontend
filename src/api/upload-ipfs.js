import { ethers } from "ethers";

const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_PIN_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const UPLOAD_AUDIT_EVENT = "vinunft.ipfs_upload";

function envValue(name) {
    return process.env[name];
}

const MAX_UPLOAD_BYTES = Number(
    envValue("PINATA_MAX_UPLOAD_BYTES") || 10 * 1024 * 1024
);
const MAX_REQUEST_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.4);
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_UPLOADS_PER_WINDOW = Number(
    envValue("PINATA_MAX_UPLOADS_PER_WINDOW") || 20
);
const MAX_GLOBAL_UPLOADS_PER_WINDOW = Number(
    envValue("PINATA_MAX_GLOBAL_UPLOADS_PER_WINDOW") || 200
);
const uploadRateLimit = new Map();

export const config = {
    bodyParser: {
        json: {
            limit: `${MAX_REQUEST_BYTES}b`,
        },
    },
};

function parseBody(req) {
    if (typeof req.body === "string") {
        return JSON.parse(req.body);
    }

    return req.body || {};
}

function sendJson(res, statusCode, body) {
    res.status(statusCode);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(body));
}

function hashAuditValue(value) {
    return ethers.utils.id(`vinunft-upload-audit:${value}`).slice(2, 18);
}

function walletAuditHash(auth) {
    if (!auth?.address) {
        return null;
    }

    try {
        return hashAuditValue(ethers.utils.getAddress(auth.address));
    } catch {
        return "invalid";
    }
}

function uploadTypeForAudit(payload) {
    if (payload?.type === "json" || payload?.type === "file") {
        return payload.type;
    }

    return payload?.type ? "unsupported" : "unknown";
}

function uploadAuditContext(req, payload) {
    const auth = payload?.auth || {};
    const context = {
        event: UPLOAD_AUDIT_EVENT,
        uploadType: uploadTypeForAudit(payload),
        hasAuth: Boolean(payload?.auth),
        hasSignature: Boolean(auth.signature),
        walletHash: walletAuditHash(auth),
        clientIpHash: hashAuditValue(clientIp(req)),
        metadataPresent: Boolean(payload?.metadata),
    };

    if (payload?.type === "file") {
        context.fileContentType = payload.contentType || null;
        context.declaredFileSizeBytes = Number.isFinite(Number(payload.size))
            ? Number(payload.size)
            : null;
    }

    return context;
}

function uploadAuditReason(error) {
    const message = error?.message || "";

    if (message.includes("PINATA_API_JWT")) return "missing_pinata_jwt";
    if (message.includes("PINATA_ALLOWED_UPLOAD_ADDRESSES")) {
        return "missing_upload_allowlist";
    }
    if (message.includes("not authorized")) return "wallet_not_allowed";
    if (message.includes("rate limit")) return "rate_limited";
    if (message.includes("wallet signature")) return "missing_signature";
    if (message.includes("expired or not yet valid")) return "stale_signature";
    if (message.includes("does not match")) return "invalid_signature";
    if (message.includes("exceeds the upload limit"))
        return "payload_too_large";
    if (message.includes("Unsupported upload type")) return "unsupported_type";
    if (message.includes("File uploads require")) return "invalid_file_payload";

    return "upload_rejected";
}

function recordUploadAudit(req, payload, event) {
    const auditEvent = {
        ...uploadAuditContext(req, payload),
        ...event,
        recordedAt: new Date().toISOString(),
    };
    const logger = event.outcome === "success" ? console.info : console.warn;

    logger(JSON.stringify(auditEvent));
}

function assertPinataJwt() {
    if (!envValue("PINATA_API_JWT")) {
        throw new Error("PINATA_API_JWT is not configured on the server.");
    }
}

function createUploadMessage(address, issuedAt) {
    return [
        "VinuNFT IPFS upload",
        `Address: ${address}`,
        `Issued At: ${issuedAt}`,
        "Purpose: mint-image",
    ].join("\n");
}

function clientIp(req) {
    const trustedHeader = envValue("TRUSTED_CLIENT_IP_HEADER");
    if (
        trustedHeader &&
        typeof req.headers[trustedHeader.toLowerCase()] === "string"
    ) {
        return req.headers[trustedHeader.toLowerCase()].trim();
    }

    return req.socket?.remoteAddress || "unknown";
}

function checkRateLimitBucket(key, maxUploads) {
    const now = Date.now();
    const existing = uploadRateLimit.get(key) || [];
    const recent = existing.filter(
        (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
    );

    if (recent.length >= maxUploads) {
        throw new Error("Upload rate limit exceeded.");
    }

    recent.push(now);
    uploadRateLimit.set(key, recent);
}

function assertRateLimit(req, address) {
    const ipAddress = clientIp(req);
    checkRateLimitBucket(
        `address:${address.toLowerCase()}`,
        MAX_UPLOADS_PER_WINDOW
    );
    checkRateLimitBucket(`ip:${ipAddress}`, MAX_UPLOADS_PER_WINDOW);
    checkRateLimitBucket("global", MAX_GLOBAL_UPLOADS_PER_WINDOW);
}

function assertAllowedUploader(address) {
    const allowedAddresses = (envValue("PINATA_ALLOWED_UPLOAD_ADDRESSES") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => ethers.utils.getAddress(value).toLowerCase());

    if (allowedAddresses.length === 0) {
        throw new Error(
            "PINATA_ALLOWED_UPLOAD_ADDRESSES must be configured before uploads are enabled."
        );
    }

    if (!allowedAddresses.includes(address.toLowerCase())) {
        throw new Error("Wallet is not authorized to upload IPFS content.");
    }
}

function assertUploadAuth(req, auth) {
    if (!auth?.address || !auth?.issuedAt || !auth?.signature) {
        throw new Error("Upload requires a wallet signature.");
    }

    const address = ethers.utils.getAddress(auth.address);
    const issuedAtMs = Date.parse(auth.issuedAt);
    const now = Date.now();

    if (
        !Number.isFinite(issuedAtMs) ||
        Math.abs(now - issuedAtMs) > 10 * 60 * 1000
    ) {
        throw new Error("Upload signature is expired or not yet valid.");
    }

    const recoveredAddress = ethers.utils.verifyMessage(
        createUploadMessage(address, auth.issuedAt),
        auth.signature
    );

    if (ethers.utils.getAddress(recoveredAddress) !== address) {
        throw new Error(
            "Upload signature does not match the supplied address."
        );
    }

    assertAllowedUploader(address);
    assertRateLimit(req, address);
}

async function pinJson(metadata) {
    const serialized = JSON.stringify(metadata);
    if (Buffer.byteLength(serialized, "utf8") > MAX_UPLOAD_BYTES) {
        throw new Error("Metadata payload exceeds the upload limit.");
    }

    const response = await fetch(PINATA_PIN_JSON_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${envValue("PINATA_API_JWT")}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ pinataContent: metadata }),
    });

    return response;
}

async function pinFile(payload) {
    if (!payload.name || !payload.contentType || !payload.data) {
        throw new Error("File uploads require name, contentType, and data.");
    }

    const fileBytes = Buffer.from(payload.data, "base64");
    if (
        fileBytes.length > MAX_UPLOAD_BYTES ||
        Number(payload.size || 0) > MAX_UPLOAD_BYTES
    ) {
        throw new Error("File payload exceeds the upload limit.");
    }

    const formData = new FormData();
    formData.append(
        "file",
        new Blob([fileBytes], { type: payload.contentType }),
        payload.name
    );

    return fetch(PINATA_PIN_FILE_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${envValue("PINATA_API_JWT")}`,
        },
        body: formData,
    });
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Method not allowed" });
    }

    let payload = {};

    try {
        assertPinataJwt();
        payload = parseBody(req);
        assertUploadAuth(req, payload.auth);
        const response =
            payload.type === "json"
                ? await pinJson(payload.metadata)
                : payload.type === "file"
                ? await pinFile(payload)
                : null;

        if (!response) {
            throw new Error("Unsupported upload type.");
        }

        const text = await response.text();
        if (!response.ok) {
            recordUploadAudit(req, payload, {
                outcome: "pinata_rejected",
                reason: "pinata_non_ok",
                statusCode: response.status,
                pinataStatus: response.status,
            });
            res.status(response.status);
            return res.send(text);
        }

        recordUploadAudit(req, payload, {
            outcome: "success",
            reason: "pinata_ok",
            statusCode: 200,
            pinataStatus: response.status,
        });
        res.status(200);
        res.setHeader("Content-Type", "application/json");
        res.send(text);
    } catch (error) {
        recordUploadAudit(req, payload, {
            outcome: "rejected",
            reason: uploadAuditReason(error),
            statusCode: 400,
        });
        return sendJson(res, 400, { error: error.message });
    }
}
