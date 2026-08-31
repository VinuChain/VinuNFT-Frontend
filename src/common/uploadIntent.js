import { ethers } from "ethers";

/**
 * Shared construction of the message a wallet signs to authorise an IPFS
 * upload. The browser and the serverless upload endpoint MUST build this
 * identically — it is the only thing standing between a captured signature
 * and arbitrary content being pinned to the project's Pinata account.
 *
 * Version 2 binds the intent to the payload digest, chain, and action.
 * Version 1 signed only address + timestamp, so any observer of one
 * signature could pin arbitrary content for the lifetime of the window.
 * The version string is inside the signed message, so a v1 signature can
 * never satisfy a v2 check.
 */
export const UPLOAD_INTENT_VERSION = "2";

/**
 * Deterministic JSON with recursively sorted object keys, so that the client
 * and the server derive the same digest from the same payload regardless of
 * property order surviving transport.
 */
export function canonicalJson(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
        .join(",")}}`;
}

/**
 * Digest of the exact payload being uploaded. Covers the file bytes, name and
 * content type for file uploads, and every metadata field for JSON uploads.
 */
export function uploadPayloadDigest(payload) {
    return ethers.utils.id(canonicalJson(payload ?? null));
}

export function createUploadMessage({
    address,
    issuedAt,
    chainId,
    action,
    digest,
}) {
    for (const [field, value] of Object.entries({
        address,
        issuedAt,
        chainId,
        action,
        digest,
    })) {
        if (value === undefined || value === null || value === "") {
            throw new Error(`createUploadMessage: missing ${field}`);
        }
    }

    return [
        "VinuNFT IPFS upload",
        `Version: ${UPLOAD_INTENT_VERSION}`,
        `Address: ${address}`,
        `Chain: ${chainId}`,
        `Action: ${action}`,
        `Payload: ${digest}`,
        `Issued At: ${issuedAt}`,
    ].join("\n");
}
