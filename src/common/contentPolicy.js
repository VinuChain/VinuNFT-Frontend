import blocklist from "../content-blocklist.json";

/**
 * What this deployment will and will not display.
 *
 * WHY a file bundled at build time rather than a service: there is no backend
 * and no moderation staff. A JSON file changed only by reviewed pull request
 * gives the audit trail (git history), the second pair of eyes and the rollback
 * for free, and it cannot fail open: a list fetched at runtime would render the
 * content it is supposed to suppress for as long as the fetch took, or forever
 * if the fetch failed.
 *
 * What it can do is bounded and stated in docs/content-policy.md: it changes
 * what THIS frontend shows. It does not touch the chain, the token, its
 * metadata, its owner, or any other client reading the same contracts.
 */

// Both the footer and every suppression notice point here, so a reporter and a
// suppressed creator are never sent to different places.
export const REPORT_URL =
    "https://github.com/VinuChain/VinuNFT-Frontend/issues/new?template=content-report.yml";
export const CONTENT_POLICY_URL =
    "https://github.com/VinuChain/VinuNFT-Frontend/blob/main/docs/content-policy.md";

const lower = (value) => String(value).toLowerCase();

function matches(entry, { nftType, tokenId, addresses }) {
    if (entry.scope === "token") {
        return (
            nftType != null &&
            tokenId != null &&
            lower(entry.key) === lower(`${nftType}/${tokenId}`)
        );
    }
    if (entry.scope === "address") {
        // Creator, owner or seller — the caller decides which addresses are
        // implicated, because that differs between a card and a listing row.
        return (addresses ?? []).some(
            (address) => address && lower(address) === lower(entry.key)
        );
    }
    return false;
}

/**
 * Pure: the whole decision, with the entries passed in.
 *
 * Returns null when nothing matches, so a call site reads as "if there is a
 * status, say so" rather than as a comparison against a sentinel action.
 */
export function evaluate(entries, target = {}) {
    const hits = (entries ?? []).filter((entry) => matches(entry, target));
    // `hide` outranks `warn`: the stronger action is the one already justified,
    // and downgrading it because a second, softer entry also matched would be
    // an accident of list order.
    const hit = hits.find((entry) => entry.action === "hide") ?? hits[0];
    if (!hit) return null;

    return {
        action: hit.action,
        category: hit.category,
        reason: hit.reason,
        evidence: hit.evidence,
        appeal: hit.appeal,
    };
}

/** The same decision against the list this build actually ships. */
export function contentStatus(target) {
    return evaluate(blocklist.entries, target);
}
