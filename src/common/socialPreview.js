const NFT_TYPES = ["text", "image"];

/**
 * Normalise the `type` and `id` route parameters of an NFT page.
 *
 * Everything downstream — contract reads, social tags, the page title — should
 * work from these rather than from the raw query string. `parseInt` alone is
 * too lenient: it turns "5abc" into 5, "<script>" into NaN, and happily accepts
 * a negative id, none of which name a real token.
 */
export function parseNftRoute(query) {
    const rawType = query?.type;
    const type = NFT_TYPES.includes(rawType) ? rawType : null;

    const rawId = query?.id;
    const id =
        typeof rawId === "string" && /^\d+$/.test(rawId) && Number(rawId) > 0
            ? Number(rawId)
            : null;

    return { type, id };
}

/**
 * Social preview values for an NFT page.
 *
 * Built only from the validated route parameters, never from token metadata:
 * an NFT's name and description are attacker-controlled, and a preview is
 * rendered by third parties whose escaping is not ours to rely on. Anything
 * unrecognised falls back to the generic VinuNFT preview rather than echoing
 * the input back. See docs/social-preview-design.md.
 */
export function socialPreview(query) {
    const { type, id } = parseNftRoute(query);
    const label = type ?? "NFT";

    if (id === null) {
        return {
            title: "VinuNFT",
            description: "VinuNFT on VinuChain mainnet.",
            url: "/nft",
            imageAlt: "VinuNFT",
        };
    }

    return {
        title: `${label} #${id} - VinuNFT`,
        description: `View ${label} NFT #${id} on VinuNFT.`,
        url: `/nft?type=${encodeURIComponent(label)}&id=${id}`,
        imageAlt: `${label} NFT #${id}`,
    };
}
