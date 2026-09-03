import React from "react";
import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useReadProvider } from "../common/provider";
import config from "../config";
import { v1 } from "../common/abi";
import { navigate } from "gatsby-link";
import { useEns } from "../common/ens";
import TypeTag from "./TypeTag";
import { isTokenExistenceError } from "../common/error";
import { useRecoilState } from "recoil";
import { formatError, standardErrorState } from "../common/error";
import HTMLViewer from "./HTMLViewer";
import MarkdownViewer from "./MarkdownViewer";
import Address from "./Address";
import Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import { fetchTokenMetadata, getTokenContent } from "../common/nftInfo";
import { contentDecision } from "../common/contentPolicy";
import ContentNotice from "./ContentNotice";

const styles = {
    card: {
        width: "52ch",
        maxWidth: "90%",
    },
    description: {
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
    },
    cardPreview: {
        height: "20ch",
        overflow: "hidden",
        padding: "3ch",
        position: "relative",
    },
    cardShadow: {
        boxShadow: "inset 0 -2em 2em -3em gray",
        position: "absolute",
        top: "0",
        left: "0",
        width: "100%",
        height: "20ch",
    },
};

export default function NFTCard({ id, type }) {
    const { lookupEns } = useEns();
    const [tokenURI, setTokenURI] = useState(null);
    const [tokenData, setTokenData] = useState(null);
    const [tokenAuthor, setTokenAuthor] = useState(null);
    // "Not read yet" and "no author" are both a null author, and the policy
    // has to tell them apart before it can let any media load.
    const [authorRead, setAuthorRead] = useState(false);
    const [readProvider, setReadProvider] = useReadProvider();
    const [tokenType, setTokenType] = useState(null);
    const [tokenContent, setTokenContent] = useState(null);
    const [exists, setExists] = useState(true);
    // A card lives in a grid: one token whose media is gone must state its own
    // failure rather than take over the page-level error banner for all of them.
    const [mediaError, setMediaError] = useState(null);
    const [_, setStandardError] = useRecoilState(standardErrorState);

    const contractAddress = config.contractAddresses.v1[type];
    const contractABI = v1[type];

    // From the card's own props and the on-chain author, never from metadata.
    // `contentHidden` is a tri-state: null until the author read has landed,
    // and the media gate below waits for a real decision.
    const { status: policyStatus, hidden: contentHidden } = contentDecision(
        { nftType: type, tokenId: id, addresses: [tokenAuthor] },
        { creatorKnown: authorRead }
    );

    const queryTokenURI = async () => {
        if (!id || !readProvider) return;

        const contract = new ethers.Contract(
            contractAddress,
            contractABI,
            readProvider
        );

        try {
            const tURI = await contract.uri(id);
            setTokenURI(tURI);
        } catch (e) {
            if (isTokenExistenceError(e)) {
                setExists(false);
            } else {
                console.log(e);
                setStandardError(formatError(e));
            }
        }
    };

    const queryTokenAuthor = async () => {
        if (!id || !readProvider) return;

        const contract = new ethers.Contract(
            contractAddress,
            contractABI,
            readProvider
        );

        try {
            const author = await contract.authorOf(id);

            setTokenAuthor(author);
            // Only on a read that landed. A failed one leaves the decision
            // open: an unknown creator is not a creator no entry names, and
            // treating it as one lets a flaky RPC response fetch media that
            // creator-scoped suppression exists to keep off this page.
            setAuthorRead(true);
        } catch (e) {
            // Cleared with the author it could not read, so the invariant
            // holds here and not only in the effect that starts the read.
            setAuthorRead(false);
            if (isTokenExistenceError(e)) {
                setExists(false);
            } else {
                console.log(e);
                setStandardError(formatError(e));
                // Not a skeleton forever: the card states its own failure,
                // exactly as it does for unreachable media.
                setMediaError("Creator unavailable, media not checked");
            }
        }
    };

    const queryTokenData = async () => {
        if (!tokenURI) return;

        try {
            const result = await fetchTokenMetadata(tokenURI);
            setTokenData(result.metadata);
        } catch (e) {
            console.log(e);
            setMediaError("Metadata unavailable");
        }
    };

    const queryTokenContent = async () => {
        if (!type || !tokenData) return;
        // Suppressed media is not fetched at all, not fetched and then hidden.
        // `!== false` and not a falsy check: while the creator read is still in
        // flight the policy has decided nothing, and undecided is not consent.
        // The effect below re-runs this the moment it becomes a decision.
        if (contentHidden !== false) return;
        try {
            const newTokenContent = await getTokenContent(type, tokenData);
            if (newTokenContent.exists) {
                setTokenContent(newTokenContent.content);
                setTokenType(newTokenContent.tokenType);
            } else {
                setMediaError("No media");
            }
        } catch (e) {
            console.log(e);
            setMediaError("Media unavailable");
        }
    };

    useEffect(() => {
        queryTokenURI();
    }, [id, type, readProvider]);
    useEffect(() => {
        queryTokenData();
    }, [tokenURI]);
    useEffect(() => {
        // Cleared here, in the same effect that starts the read, so a card
        // moved to another token cannot carry the previous token's decision.
        setAuthorRead(false);
        queryTokenAuthor();
    }, [id, type, readProvider]);
    // Keyed on the tri-state scalar, never on `policyStatus`: that is a fresh
    // object every render and would loop.
    useEffect(() => {
        queryTokenContent();
    }, [tokenData, contentHidden]);
    useEffect(() => {
        setExists(true);
    }, [id, type, readProvider]);

    const effectiveTokenAuthor = tokenAuthor || null;
    const nftPath = `/nft?type=${type}&id=${id}`;
    const tokenLabel = tokenData?.name || `${type} NFT #${id}`;
    const imageAltText = `${tokenLabel} image preview`;
    const handleCardKeyDown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            navigate(nftPath);
        }
    };

    if (!exists) {
        return <></>;
    }

    return (
        <div
            className="card m-3 cursor-pointer"
            style={styles.card}
            onClick={() => navigate(nftPath)}
            onKeyDown={handleCardKeyDown}
            role="link"
            tabIndex={0}
            aria-label={`View ${tokenLabel}`}
        >
            <div style={styles.cardPreview}>
                {policyStatus ? (
                    <ContentNotice status={policyStatus} compact />
                ) : mediaError ? (
                    <p className="nft-media-unavailable nft-muted">
                        {mediaError}
                    </p>
                ) : type === "image" ? (
                    <img
                        src={tokenContent}
                        alt={imageAltText}
                        style={{ objectFit: "contain", width: "100%" }}
                    />
                ) : tokenType && tokenContent !== null ? (
                    tokenType == "text/html" ? (
                        <HTMLViewer source={tokenContent} />
                    ) : tokenType == "text/markdown" ? (
                        <MarkdownViewer source={tokenContent} />
                    ) : (
                        <pre
                            className="nft-plain"
                            style={{ overflow: "hidden" }}
                        >
                            {tokenContent}
                        </pre>
                    )
                ) : (
                    <Skeleton count={10} />
                )}
            </div>
            <div style={styles.cardShadow}></div>
            <div className="card-content">
                <div className="media">
                    <div className="media-content">
                        <p className="title is-4 mb-0">
                            {contentHidden
                                ? `${type} NFT #${id}`
                                : tokenData?.name ||
                                  (tokenData ? (
                                      "Untitled"
                                  ) : mediaError ? (
                                      mediaError
                                  ) : (
                                      <Skeleton />
                                  ))}
                        </p>
                        <span className="subtitle is-6">
                            {effectiveTokenAuthor !== null ? (
                                <span>
                                    by{" "}
                                    <Address
                                        address={effectiveTokenAuthor}
                                        shorten
                                        nChar={8}
                                        disableLink
                                    />
                                </span>
                            ) : (
                                <Skeleton />
                            )}
                        </span>
                    </div>
                </div>

                <div className="content is-italic" style={styles.description}>
                    {contentHidden ? (
                        ""
                    ) : tokenData ? (
                        tokenData.description ?? ""
                    ) : mediaError ? (
                        ""
                    ) : (
                        <Skeleton />
                    )}
                </div>
                <div className="has-text-right">
                    <TypeTag
                        type={type === "image" ? "image" : tokenData?.text_uri}
                        isUri={true}
                    />
                </div>
            </div>
        </div>
    );
}
