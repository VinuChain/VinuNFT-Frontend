import config from "../config";
import { createUploadMessage, uploadPayloadDigest } from "./uploadIntent";

const UPLOAD_ACTION = { file: "mint-image", json: "mint-metadata" };

/**
 * Sign an upload intent bound to this exact payload.
 *
 * The signature covers the payload digest, chain, and action, so a captured
 * signature authorises only the byte-for-byte identical upload it was made
 * for. Re-sending it re-pins identical content, which IPFS resolves to the
 * same CID and is therefore a no-op. Each payload is signed separately
 * because a mint uploads the image first and can only build the metadata
 * once the image CID is known.
 */
async function createIpfsUploadAuth(walletProvider, payload) {
    const signer = walletProvider.getSigner();
    const address = await signer.getAddress();
    const issuedAt = new Date().toISOString();
    const message = createUploadMessage({
        address,
        issuedAt,
        chainId: config.networks.main.chainId,
        action: UPLOAD_ACTION[payload.type],
        digest: uploadPayloadDigest(payload),
    });
    const signature = await signer.signMessage(message);

    return { address, issuedAt, signature };
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";

    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }

    return btoa(binary);
}

async function uploadToIpfs(payload, auth) {
    const response = await fetch(config.ipfsUploadEndpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...payload, auth }),
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "IPFS upload failed");
    }

    const result = await response.json();
    if (!result.IpfsHash) {
        throw new Error("IPFS upload response did not include an IpfsHash");
    }

    return result.IpfsHash;
}

/**
 * CIDs of payloads already pinned in this page's lifetime.
 *
 * Identical bytes always pin to the same CID, so a retry after a rejected or
 * reverted mint has nothing to gain from re-uploading: it would only spend a
 * second wallet signature and another slot of the endpoint's rate limit on
 * content that is already there.
 */
const uploadedCids = new Map();

function clearUploadCache() {
    uploadedCids.clear();
}

async function uploadPayload(payload, walletProvider) {
    const digest = uploadPayloadDigest(payload);

    if (!uploadedCids.has(digest)) {
        uploadedCids.set(
            digest,
            await uploadToIpfs(
                payload,
                await createIpfsUploadAuth(walletProvider, payload)
            )
        );
    }

    return uploadedCids.get(digest);
}

async function uploadFileToIpfs(image, walletProvider) {
    if (image.size > config.maxIpfsUploadBytes) {
        throw new Error(
            "File is larger than the configured IPFS upload limit."
        );
    }

    const payload = {
        type: "file",
        name: image.name,
        contentType: image.type || "application/octet-stream",
        size: image.size,
        data: arrayBufferToBase64(await image.arrayBuffer()),
    };

    return uploadPayload(payload, walletProvider);
}

async function uploadJSONToIpfs(json, walletProvider) {
    const payload = { type: "json", metadata: json };

    return uploadPayload(payload, walletProvider);
}

/** Thrown when a token points somewhere this app will not fetch from. */
class UnsupportedMediaSource extends Error {
    constructor(url) {
        super(
            "This NFT's media is hosted somewhere VinuNFT does not fetch from, so it cannot be displayed."
        );
        this.name = "UnsupportedMediaSource";
        this.url = url;
    }
}

/** Thrown when a response exceeds the media size cap. */
class MediaTooLarge extends Error {
    constructor(bytes) {
        super("This NFT's media is too large to display.");
        this.name = "MediaTooLarge";
        this.bytes = bytes;
    }
}

const gatewayOrigins = () =>
    config.ipfsGateways.map((gateway) => new URL(gateway).origin);

/**
 * Is this an https URL served by a gateway we trust?
 *
 * A token URI is attacker-controlled — ImageNFT.mint stores any string — and
 * this runs in the viewer's browser. Fetching arbitrary hosts would let a
 * minted NFT probe every viewer's private network and log their address, and
 * would make image availability depend on a host nobody vetted.
 */
function isAllowedHttpsUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return (
        parsed.protocol === "https:" && gatewayOrigins().includes(parsed.origin)
    );
}

async function fetchWithLimits(url) {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        config.mediaFetchTimeoutMs
    );

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(
                `Media request failed with status ${response.status}`
            );
        }

        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > config.maxMediaFetchBytes) {
            throw new MediaTooLarge(declared);
        }

        // Cap while streaming, so an undeclared or lying Content-Length cannot
        // still pull an unbounded body into memory.
        const body = await readCapped(response, config.maxMediaFetchBytes);

        return new Response(body, {
            status: response.status,
            headers: {
                "content-type":
                    response.headers.get("content-type") ||
                    "application/octet-stream",
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

async function readCapped(response, maxBytes) {
    if (!response.body?.getReader) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) {
            throw new MediaTooLarge(buffer.byteLength);
        }
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
            await reader.cancel();
            throw new MediaTooLarge(received);
        }
        chunks.push(value);
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

/**
 * Decode a `data:` URI into a Response without touching the network.
 *
 * `fetch()` on a `data:` URL is still governed by CSP `connect-src`, which does
 * not list `data:` and must not: widening it to satisfy an inline decode would
 * buy nothing and weaken the policy. Every text NFT carries its body as a
 * `data:` URI, so fetching them meant the body silently never resolved in
 * production and the page held a permanent skeleton.
 */
function responseFromDataUri(url) {
    const comma = url.indexOf(",");
    if (comma === -1) {
        throw new UnsupportedMediaSource(url);
    }

    const meta = url.slice("data:".length, comma);
    const isBase64 = /;base64$/i.test(meta);
    const mediaType =
        (isBase64 ? meta.slice(0, -";base64".length) : meta) ||
        "text/plain;charset=US-ASCII";
    const payload = url.slice(comma + 1);

    let bytes;
    try {
        bytes = isBase64
            ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(decodeURIComponent(payload));
    } catch {
        // Malformed base64 or percent-encoding. Refuse it the same way an
        // unsupported scheme is refused, so callers report it honestly.
        throw new UnsupportedMediaSource(url);
    }

    return new Response(bytes, { headers: { "Content-Type": mediaType } });
}

/**
 * Fetch token media, restricted to sources this app is willing to reach.
 *
 * `data:` is decoded inline with no network egress at all, and carries
 * the on-chain metadata for text NFTs. `ipfs://` is resolved through the
 * configured gateways in order, so one gateway failing degrades instead of
 * blanking every image. A plain https URL is only fetched when it is already
 * one of those gateways. Anything else is refused, and callers surface that
 * honestly rather than silently showing nothing.
 */
async function maybeFetchIpfs(url) {
    if (typeof url !== "string" || url.length === 0) {
        throw new UnsupportedMediaSource(url);
    }

    if (url.startsWith("data:")) {
        return responseFromDataUri(url);
    }

    if (url.startsWith("ipfs://")) {
        const path = url.slice("ipfs://".length).replace(/^ipfs\//, "");
        let lastError;
        for (const gateway of config.ipfsGateways) {
            try {
                return await fetchWithLimits(`${gateway}/${path}`);
            } catch (error) {
                if (error instanceof MediaTooLarge) throw error;
                lastError = error;
            }
        }
        throw lastError ?? new UnsupportedMediaSource(url);
    }

    if (isAllowedHttpsUrl(url)) {
        return fetchWithLimits(url);
    }

    throw new UnsupportedMediaSource(url);
}

export {
    UnsupportedMediaSource,
    MediaTooLarge,
    isAllowedHttpsUrl,
    createIpfsUploadAuth,
    clearUploadCache,
    uploadFileToIpfs,
    uploadJSONToIpfs,
    maybeFetchIpfs,
};
