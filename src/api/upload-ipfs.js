import { ethers } from "ethers";
import {
    createUploadMessage,
    uploadPayloadDigest,
} from "../common/uploadIntent";
import { sniffImage } from "../common/imageSniff";
// One parseBody, not a private copy: the copy here was unguarded and safe only
// because its call site happens to sit inside the handler's try.
import { clientKey, parseBody } from "../common/apiRateLimit";
import {
    consumeRateLimit,
    RateLimitStoreError,
} from "../common/uploadRateLimit";

const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_PIN_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const UPLOAD_AUDIT_EVENT = "vinunft.ipfs_upload";
const MAX_AUDIT_CONTENT_TYPE_LENGTH = 128;

class UploadRejection extends Error {
    constructor(reason, message) {
        super(message);
        this.name = "UploadRejection";
        this.auditReason = reason;
    }
}

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
const UPLOAD_CHAIN_ID = Number(envValue("UPLOAD_CHAIN_ID") || 207);

// Raster formats only. SVG is deliberately excluded: it is script bearing, and
// a gateway serving it as image/svg+xml executes that script on the gateway
// origin. The declared content type must also match the bytes, which is what
// stops a polyglot or a renamed script being pinned as an image.
const ALLOWED_MEDIA_TYPES = (
    envValue("PINATA_ALLOWED_MEDIA_TYPES") ||
    "image/png,image/jpeg,image/gif,image/webp"
)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

// Guards a decompression bomb on its declared geometry, without decoding it.
const MAX_IMAGE_PIXELS = Number(
    envValue("PINATA_MAX_IMAGE_PIXELS") || 40000000
);

export const config = {
    bodyParser: {
        json: {
            limit: `${MAX_REQUEST_BYTES}b`,
        },
    },
};

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

function fileContentTypeForAudit(payload) {
    if (typeof payload?.contentType !== "string") {
        return null;
    }

    const contentType = payload.contentType.trim().toLowerCase();
    if (
        contentType.length <= MAX_AUDIT_CONTENT_TYPE_LENGTH &&
        /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
            contentType
        )
    ) {
        return contentType;
    }

    return "other";
}

function uploadAuditContext(req, payload) {
    const auth = payload?.auth || {};
    const context = {
        event: UPLOAD_AUDIT_EVENT,
        uploadType: uploadTypeForAudit(payload),
        hasAuth: Boolean(payload?.auth),
        hasSignature: Boolean(auth.signature),
        walletHash: walletAuditHash(auth),
        metadataPresent: Boolean(payload?.metadata),
    };

    if (payload?.type === "file") {
        context.fileContentType = fileContentTypeForAudit(payload);
        context.declaredFileSizeBytes = Number.isFinite(Number(payload.size))
            ? Number(payload.size)
            : null;
    }

    return context;
}

function uploadAuditReason(error) {
    return error instanceof UploadRejection
        ? error.auditReason
        : "upload_rejected";
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
        throw new UploadRejection(
            "missing_pinata_jwt",
            "PINATA_API_JWT is not configured on the server."
        );
    }
}

// Bucket keys are hashed: the same identifiers the audit log refuses to record
// in the clear should not sit in a third-party store either, and a hash bounds
// the key length against a long trusted-header value.
async function assertRateLimit(req, address) {
    let exceeded;

    try {
        exceeded = await consumeRateLimit(
            [
                {
                    key: `address:${hashAuditValue(address.toLowerCase())}`,
                    limit: MAX_UPLOADS_PER_WINDOW,
                },
                {
                    key: `ip:${hashAuditValue(clientKey(req))}`,
                    limit: MAX_UPLOADS_PER_WINDOW,
                },
                { key: "global", limit: MAX_GLOBAL_UPLOADS_PER_WINDOW },
            ],
            RATE_LIMIT_WINDOW_MS
        );
    } catch (error) {
        if (error instanceof RateLimitStoreError) {
            // Fail closed. An upload that cannot be counted is an upload with
            // no limit at all, which is worse than a refused one.
            throw new UploadRejection(
                "rate_limit_store_unavailable",
                "Upload rate limiting is unavailable; try again shortly."
            );
        }
        throw error;
    }

    if (exceeded) {
        throw new UploadRejection(
            "rate_limited",
            "Upload rate limit exceeded."
        );
    }
}

function assertAllowedUploader(address) {
    const allowedAddresses = (envValue("PINATA_ALLOWED_UPLOAD_ADDRESSES") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => ethers.utils.getAddress(value).toLowerCase());

    if (allowedAddresses.length === 0) {
        throw new UploadRejection(
            "missing_upload_allowlist",
            "PINATA_ALLOWED_UPLOAD_ADDRESSES must be configured before uploads are enabled."
        );
    }

    if (!allowedAddresses.includes(address.toLowerCase())) {
        throw new UploadRejection(
            "wallet_not_allowed",
            "Wallet is not authorized to upload IPFS content."
        );
    }
}

const UPLOAD_ACTION = { file: "mint-image", json: "mint-metadata" };

/** The signed digest must cover the payload the server is about to pin, so
 *  `auth` itself is excluded from the digested object. */
function digestedPayload(payload) {
    const { auth, ...rest } = payload ?? {};
    return rest;
}

async function assertUploadAuth(req, payload) {
    const auth = payload?.auth;
    if (!auth?.address || !auth?.issuedAt || !auth?.signature) {
        throw new UploadRejection(
            "missing_signature",
            "Upload requires a wallet signature."
        );
    }

    const address = ethers.utils.getAddress(auth.address);
    const issuedAtMs = Date.parse(auth.issuedAt);
    const now = Date.now();

    if (
        !Number.isFinite(issuedAtMs) ||
        Math.abs(now - issuedAtMs) > 10 * 60 * 1000
    ) {
        throw new UploadRejection(
            "stale_signature",
            "Upload signature is expired or not yet valid."
        );
    }

    const action = UPLOAD_ACTION[payload?.type];
    if (!action) {
        throw new UploadRejection(
            "unsupported_type",
            "Unsupported upload type."
        );
    }

    // Rebuild the message from the payload actually received. A signature
    // captured for one upload cannot authorise different content, a different
    // action, or a different chain.
    const recoveredAddress = ethers.utils.verifyMessage(
        createUploadMessage({
            address,
            issuedAt: auth.issuedAt,
            chainId: UPLOAD_CHAIN_ID,
            action,
            digest: uploadPayloadDigest(digestedPayload(payload)),
        }),
        auth.signature
    );

    if (ethers.utils.getAddress(recoveredAddress) !== address) {
        throw new UploadRejection(
            "invalid_signature",
            "Upload signature does not authorise this payload."
        );
    }

    assertAllowedUploader(address);
    await assertRateLimit(req, address);
}

async function pinJson(metadata) {
    const serialized = JSON.stringify(metadata);
    if (Buffer.byteLength(serialized, "utf8") > MAX_UPLOAD_BYTES) {
        throw new UploadRejection(
            "payload_too_large",
            "Metadata payload exceeds the upload limit."
        );
    }

    const response = await globalThis.fetch(PINATA_PIN_JSON_URL, {
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
        throw new UploadRejection(
            "invalid_file_payload",
            "File uploads require name, contentType, and data."
        );
    }

    const declaredType = String(payload.contentType).trim().toLowerCase();
    if (!ALLOWED_MEDIA_TYPES.includes(declaredType)) {
        throw new UploadRejection(
            "media_type_not_allowed",
            "File type is not an accepted image format."
        );
    }

    const fileBytes = Buffer.from(payload.data, "base64");
    if (
        fileBytes.length > MAX_UPLOAD_BYTES ||
        Number(payload.size || 0) > MAX_UPLOAD_BYTES
    ) {
        throw new UploadRejection(
            "payload_too_large",
            "File payload exceeds the upload limit."
        );
    }

    // The bytes decide the type, not the client. A mismatch means the payload
    // was mislabelled — a polyglot, a renamed script, or an SVG.
    const sniffed = sniffImage(fileBytes);
    if (!sniffed) {
        throw new UploadRejection(
            "unrecognised_image",
            "File is not a recognised image."
        );
    }
    if (sniffed.mediaType !== declaredType) {
        throw new UploadRejection(
            "media_type_mismatch",
            "File contents do not match the declared file type."
        );
    }
    if (sniffed.width * sniffed.height > MAX_IMAGE_PIXELS) {
        throw new UploadRejection(
            "image_too_large",
            "Image dimensions exceed the upload limit."
        );
    }

    const formData = new FormData();
    formData.append(
        "file",
        new Blob([fileBytes], { type: declaredType }),
        payload.name
    );

    return globalThis.fetch(PINATA_PIN_FILE_URL, {
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
        if (!payload) {
            throw new UploadRejection(
                "malformed_body",
                "Malformed request body."
            );
        }
        await assertUploadAuth(req, payload);
        const response =
            payload.type === "json"
                ? await pinJson(payload.metadata)
                : payload.type === "file"
                ? await pinFile(payload)
                : null;

        if (!response) {
            throw new UploadRejection(
                "unsupported_type",
                "Unsupported upload type."
            );
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
