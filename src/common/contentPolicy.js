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
        // The creator, or a listing's seller — the caller decides which
        // addresses are implicated, because that differs between a card and a
        // listing row. Both are known before anything is rendered or fetched,
        // which is what makes suppression before the fetch possible at all.
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

/**
 * Pure: the decision, and whether it is a decision yet.
 *
 * `hidden` is a tri-state. `null` means "not decided": an address entry can
 * name the token's creator, the creator is an `authorOf` read, and until that
 * read lands nothing here can rule the token in. Callers gate media loading on
 * `hidden === false` — spending "unknown" as permission fetches exactly the
 * bytes an entry exists to suppress, which is the one thing `hide` promises
 * will not happen.
 *
 * A token-scoped hide is certain without the creator, so it never waits.
 */
export function decideContent(entries, target, { creatorKnown = true } = {}) {
    const status = evaluate(entries, target);
    return {
        status,
        hidden: status?.action === "hide" ? true : creatorKnown ? false : null,
    };
}

/** The same decision against the list this build actually ships. */
export function contentDecision(target, options) {
    return decideContent(blocklist.entries, target, options);
}

/**
 * Pure: the listings this deployment will offer, and how many it will not.
 *
 * A listing is withdrawn by an entry naming its token, its seller or its
 * creator — the same scope the media decision uses, because a token this
 * deployment will not show is one it must not sell either. Reselling is not a
 * way around a hide. The counts are returned rather than swallowed: a row that
 * exists on chain but is not offered here still exists, and a page that drops
 * it silently reports a smaller market than there is. They are two counts
 * because there are two reasons — a hide, and a creator this load could not
 * read — and only one of them is a decision about the content.
 *
 * `fallback` carries what a call site's rows do not. Marketplace rows already
 * name their token and creator; the token page reads `listings(nftAddress, id,
 * i)`, whose rows name only a seller and an amount, so the page supplies its
 * own id and its own `authorOf` read.
 */
export function partitionListings(entries, listings, fallback = {}) {
    const shown = [];
    let hiddenByPolicy = 0;
    let withheldUnknownCreator = 0;

    for (const listing of listings ?? []) {
        const { hidden } = decideContent(
            entries,
            {
                nftType: listing.nftType ?? fallback.nftType,
                tokenId: listing.tokenId ?? fallback.tokenId,
                addresses: [
                    listing.seller,
                    listing.creator ?? fallback.creator,
                ],
            },
            {
                // The same tri-state the media decision uses, for the same
                // reason: a creator that could not be READ is not a creator no
                // entry names, and spending "unknown" as permission offers
                // exactly the token an entry exists to withdraw. Rows that
                // state nothing are treated as read, so callers whose creator
                // is not in question are unaffected.
                creatorKnown:
                    listing.creatorKnown ?? fallback.creatorKnown ?? true,
            }
        );
        if (hidden === false) {
            shown.push(listing);
        } else if (hidden === true) {
            hiddenByPolicy += 1;
        } else {
            // Counted apart from a policy hide, because the two are different
            // facts and a page that reports an unreadable creator as a
            // moderation decision is telling the visitor something untrue.
            withheldUnknownCreator += 1;
        }
    }

    return { shown, hiddenByPolicy, withheldUnknownCreator };
}

/** The same split against the list this build actually ships. */
export function visibleListings(listings, fallback) {
    return partitionListings(blocklist.entries, listings, fallback);
}
