import React from "react";
import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useReadProvider } from "../common/provider";
import config from "../config";
import { v1 } from "../common/abi";
import { navigate } from "gatsby-link";
import MDEditor from "@uiw/react-md-editor";
import rehypeSanitize from "rehype-sanitize";
import schemas from "../common/schemas";
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
import { maybeFetchIpfs } from "../common/ipfs";
import { getTokenContent } from "../common/nftInfo";

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
    const [readProvider, setReadProvider] = useReadProvider();
    const [tokenType, setTokenType] = useState(null);
    const [tokenContent, setTokenContent] = useState(null);
    const [exists, setExists] = useState(true);
    const [_, setStandardError] = useRecoilState(standardErrorState);

    const contractAddress = config.contractAddresses.v1[type];
    const contractABI = v1[type];

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
        } catch (e) {
            if (isTokenExistenceError(e)) {
                setExists(false);
            } else {
                console.log(e);
                setStandardError(formatError(e));
            }
        }
    };

    const queryTokenData = async () => {
        if (!tokenURI) return;

        try {
            const tokenDataResponse = await maybeFetchIpfs(tokenURI);
            const newTokenData = await tokenDataResponse.json();
            //console.log(newTokenData)
            setTokenData(newTokenData);
        } catch (e) {
            console.log(e);
            setStandardError(formatError(e));
        }
    };

    const queryTokenContent = async () => {
        if (!type || !tokenData) return;
        try {
            const newTokenContent = await getTokenContent(type, tokenData);
            if (newTokenContent.exists) {
                setTokenContent(newTokenContent.content);
                setTokenType(newTokenContent.tokenType);
            }
        } catch (e) {
            console.log(e);
            setStandardError(formatError(e));
        }
    };

    useEffect(() => {
        queryTokenURI();
    }, [id, type, readProvider]);
    useEffect(() => {
        queryTokenData();
    }, [tokenURI]);
    useEffect(() => {
        queryTokenAuthor();
    }, [id, type, readProvider]);
    useEffect(() => {
        queryTokenContent();
    }, [tokenData]);
    useEffect(() => {
        setExists(true);
    }, [id, type, readProvider]);

    const effectiveTokenAuthor = tokenAuthor || null;

    if (!exists) {
        return <></>;
    }

    return (
        <div
            className="card m-3 cursor-pointer"
            style={styles.card}
            onClick={() => navigate(`/nft?type=${type}&id=${id}`)}
        >
            <div style={styles.cardPreview}>
                {type === "image" ? (
                    <img
                        src={tokenContent}
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
                            {tokenData?.name || <Skeleton />}
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
                    {tokenData?.description !== undefined &&
                    tokenData?.description !== null ? (
                        tokenData.description
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
