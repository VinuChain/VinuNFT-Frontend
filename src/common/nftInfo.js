import { maybeFetchIpfs } from "./ipfs";

async function getTokenContent(nftType, tokenData) {
    if (nftType === "text") {
        if (!tokenData?.text_uri) return { exists: false };
        let parsedTextURI = tokenData.text_uri.replaceAll("#", "%23"); //TODO: workaround, togliere con nuovo deploy
        parsedTextURI = parsedTextURI.replace("charset=UTF-8,", "");

        const response = await maybeFetchIpfs(parsedTextURI);
        const parsedText = await response.text();
        //console.log("content: " + parsedTextURI)

        const tokenType = response.headers.get("content-type");

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
