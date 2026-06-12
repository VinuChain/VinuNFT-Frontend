import config from "../config";

function createUploadMessage(address, issuedAt) {
    return [
        "VinuNFT IPFS upload",
        `Address: ${address}`,
        `Issued At: ${issuedAt}`,
        "Purpose: mint-image",
    ].join("\n");
}

async function createIpfsUploadAuth(walletProvider) {
    const signer = walletProvider.getSigner();
    const address = await signer.getAddress();
    const issuedAt = new Date().toISOString();
    const message = createUploadMessage(address, issuedAt);
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

async function uploadFileToIpfs(image, auth) {
    if (image.size > config.maxIpfsUploadBytes) {
        throw new Error(
            "File is larger than the configured IPFS upload limit."
        );
    }

    return uploadToIpfs(
        {
            type: "file",
            name: image.name,
            contentType: image.type || "application/octet-stream",
            size: image.size,
            data: arrayBufferToBase64(await image.arrayBuffer()),
        },
        auth
    );
}

async function uploadJSONToIpfs(json, auth) {
    return uploadToIpfs(
        {
            type: "json",
            metadata: json,
        },
        auth
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
