import { maybeFetchIpfs } from "./ipfs";
import schemas from "./schemas";

// Derive the render MIME type from the on-chain URI — never from the remote
// Content-Type header, which can be attacker-controlled. Exported because the
// marketplace card states the same format the token page renders, and two
// parsers would eventually disagree about the same token.
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

/**
 * Read a token's metadata document, and say where it physically came from.
 *
 * One seam, because both the card and the detail page used to parse this
 * themselves and neither validated it. The returned `metadata` is Joi's
 * stripped value, never the parsed body: validating and then storing the
 * original would leave the hostile field in React state and change nothing.
 *
 * `source` is provenance the page must state — an on-chain `data:` document is
 * as durable as the token itself, an external one is only as available as the
 * gateway serving it, and the viewer cannot tell those apart from the render.
 */
async function fetchTokenMetadata(uri) {
    const response = await maybeFetchIpfs(uri);
    const raw = await response.json();

    const { value, error } = schemas.tokenMetadata.validate(raw);
    if (error) {
        // Deliberately fixed copy: the metadata is attacker-controlled, and
        // Joi's message would quote parts of it back into the page.
        throw new Error(
            "This NFT's metadata does not match the expected format, so it cannot be displayed."
        );
    }

    return {
        metadata: value,
        source: uri.startsWith("data:") ? "on-chain" : "external",
        uri,
    };
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

export { deriveTokenType, fetchTokenMetadata, getTokenContent };
