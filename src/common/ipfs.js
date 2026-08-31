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

    return uploadToIpfs(
        payload,
        await createIpfsUploadAuth(walletProvider, payload)
    );
}

async function uploadJSONToIpfs(json, walletProvider) {
    const payload = { type: "json", metadata: json };

    return uploadToIpfs(
        payload,
        await createIpfsUploadAuth(walletProvider, payload)
    );
}

async function maybeFetchIpfs(url) {
    if (url.startsWith("ipfs://")) {
        const hash = url.split("ipfs://")[1];
        const response = await fetch(`${config.standardIpfsGateway}/${hash}`);
        return response;
    } else {
        return await fetch(url);
    }
}

export {
    createIpfsUploadAuth,
    uploadFileToIpfs,
    uploadJSONToIpfs,
    maybeFetchIpfs,
};
