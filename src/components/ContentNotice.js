import React from "react";
import { CONTENT_POLICY_URL, REPORT_URL } from "../common/contentPolicy";

const HEADING = {
    hide: "Hidden by content policy",
    warn: "Flagged by content policy",
};

/**
 * Suppression, stated.
 *
 * An item removed from view without explanation is indistinguishable from an
 * item that never existed, which is both dishonest and unappealable. This says
 * what happened, under which classification, why, and what it does NOT do —
 * because the one thing this product must never imply is that anything was
 * deleted from the chain.
 *
 * `compact` drops the standing explanation for grid cards, where it would
 * repeat once per tile; the card links through to the page that carries it.
 */
export default function ContentNotice({ status, compact }) {
    if (!status) return null;

    return (
        <div
            className={`content-notice notification is-warning is-light p-3 ${
                status.action === "hide"
                    ? "content-notice--hidden"
                    : "content-notice--warned"
            }`}
        >
            <p className="has-text-weight-semibold is-size-7">
                {HEADING[status.action]} — {status.category}
            </p>
            <p className="is-size-7">{status.reason}</p>
            {compact ? null : (
                <>
                    <p className="is-size-7 mt-2">
                        This changes what this app displays and nothing else.
                        The token, its metadata and its transaction history stay
                        on VinuChain, where nobody can edit or erase them, this
                        site&apos;s operator included. Ownership is untouched:
                        whoever holds the token still holds it and can still
                        transfer, list or burn it, from this app or any other.
                        Media hosted on IPFS may separately have been unpinned,
                        which does not delete it from anyone else pinning it.
                    </p>
                    <p className="is-size-7 mt-2">
                        Appeal: {status.appeal}{" "}
                        <a
                            target="_blank"
                            rel="noreferrer nofollow"
                            href={CONTENT_POLICY_URL}
                        >
                            Content policy
                        </a>{" "}
                        ·{" "}
                        <a
                            target="_blank"
                            rel="noreferrer nofollow"
                            href={REPORT_URL}
                        >
                            Report content
                        </a>
                    </p>
                </>
            )}
        </div>
    );
}
