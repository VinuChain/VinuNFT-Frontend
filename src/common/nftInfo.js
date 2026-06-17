import { maybeFetchIpfs } from "./ipfs";

// Derive the render MIME type from the on-chain URI — never from the remote
// Content-Type header, which can be attacker-controlled.
function deriveTokenType(textUri) {
    if (textUri.startsWith("data:")) {
        // data:<mime>[;base64],<data> — parse the declared MIME
        const mime = textUri.slice(5).split(/[;,]/)[0].trim();
        if (mime === "text/markdown" || mime === "text/html") return mime;
        // Any other data: MIME falls through to plain text
        return "text/plain";
    }
    if (textUri.startsWith("ipfs://") || textUri.startsWith("ipfs%3A%2F%2F")) {
        // IPFS-hosted content is the platform's text/markdown path
        return "text/markdown";
    }
    // Non-ipfs, non-data URLs: render as plain text to prevent renderer hijacking
    return "text/plain";
}

async function getTokenContent(nftType, tokenData) {
    if (nftType === "text") {
        if (!tokenData?.text_uri) return { exists: false };
        let parsedTextURI = tokenData.text_uri.replaceAll("#", "%23"); //TODO: workaround, togliere con nuovo deploy
        parsedTextURI = parsedTextURI.replace("charset=UTF-8,", "");

        const tokenType = deriveTokenType(tokenData.text_uri);

        const response = await maybeFetchIpfs(parsedTextURI);
        const parsedText = await response.text();
        //console.log("content: " + parsedTextURI)

        return { exists: true, tokenType, content: parsedText };
    } else if (nftType === "image") {
        if (!tokenData?.image) return { exists: false };

        // console.log("Token data URI: ", tokenData.image);

        const response = await maybeFetchIpfs(tokenData.image);
        // console.log("Token data response:", response);
        const blob = await response.blob();
        // console.log("Blob:", blob);
        const url = URL.createObjectURL(blob);
        // console.log("Final URL:", url);

        return { exists: true, tokenType: "image", content: url };
    } else {
        throw new Error("Unsupported NFT type");
    }
}

export { getTokenContent };
