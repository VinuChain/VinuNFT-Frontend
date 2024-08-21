import React, { useEffect, useState } from "react";
import { useReadProvider } from "../common/provider";
import { NFTCard } from "../components";
import InfiniteScroll from "react-infinite-scroll-component";
import config from "../config";
import { v1 } from "../common/abi";
import { ethers } from "ethers";
import { Header } from "../components";
import { Helmet } from "react-helmet";
import { useRecoilState } from "recoil";
import { formatError, standardErrorState } from "../common/error";
import StandardErrorDisplay from "../components/StandardErrorDisplay";

import "bulma/css/bulma.min.css";
import "../styles/globals.css";

export default function Home() {
    const [readProvider] = useReadProvider();
    const [lastTextNFTId, setLastTextNFTId] = useState(null);
    const [lastImageNFtId, setLastImageNFTId] = useState(null);
    const [textNfts, setTextNFTs] = useState([]);
    const [imageNfts, setImageNFTs] = useState([]);

    const [, setStandardError] = useRecoilState(standardErrorState);

    const increment = 5;

    useEffect(async () => {
        const textContract = new ethers.Contract(
            config.contractAddresses.v1.text,
            v1.text,
            readProvider
        );
        const imageContract = new ethers.Contract(
            config.contractAddresses.v1.image,
            v1.image,
            readProvider
        );

        try {
            const newLastTextNFTId = await textContract.lastTokenId();
            const newLastImageNFTId = await imageContract.lastTokenId();
            setLastTextNFTId(newLastTextNFTId.toNumber());
            setLastImageNFTId(newLastImageNFTId.toNumber());
        } catch (e) {
            setStandardError(formatError(e));
        }
    }, []);

    const getMoreIds = (count) => {
        const newTextNfts = [...textNfts];
        const newImageNfts = [...imageNfts];

        for (let i = 0; i < count; i++) {
            // TODO: This is incorrect
            const newTextNftId = lastTextNFTId - newTextNfts.length;
            if (newTextNftId >= 1) {
                newTextNfts.push(newTextNftId);
            }
            const newImageNftId = lastImageNFtId - newImageNfts.length;
            if (newImageNftId >= 1) {
                newImageNfts.push(newImageNftId);
            }
        }

        setTextNFTs(newTextNfts);
        setImageNFTs(newImageNfts);
    };

    const interleavedNfts = [];

    for (let i = 0; i < Math.max(textNfts.length, imageNfts.length); i++) {
        if (i < textNfts.length) {
            interleavedNfts.push({ type: "text", id: textNfts[i] });
        }
        if (i < imageNfts.length) {
            interleavedNfts.push({ type: "image", id: imageNfts[i] });
        }
    }

    useEffect(() => getMoreIds(20), [lastTextNFTId, lastImageNFtId]);

    return (
        <div>
            <Helmet>
                <title>text</title>
            </Helmet>
            <Header />
            <StandardErrorDisplay />
            <div className="columns m-4">
                <div className="column">
                    <h1 className="title has-text-centered">Latest NFTs</h1>
                    <InfiniteScroll
                        dataLength={interleavedNfts.length}
                        next={() => getMoreIds(increment)}
                        hasMore={
                            textNfts.length < lastTextNFTId ||
                            imageNfts.length < lastImageNFtId
                        }
                        loader={<h4>Loading...</h4>}
                        endMessage={
                            lastTextNFTId === null ? (
                                <p style={{ textAlign: "center" }}>
                                    Loading...
                                </p>
                            ) : (
                                <p style={{ textAlign: "center" }}>
                                    <b>That's all folks!</b>
                                </p>
                            )
                        }
                    >
                        <div
                            className="is-flex is-flex-direction-row is-flex-wrap-wrap"
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                justifyContent: "center",
                            }}
                        >
                            {interleavedNfts.map(({ id, type }) => (
                                <NFTCard
                                    id={id}
                                    type={type}
                                    key={type + "-" + id}
                                />
                            ))}
                        </div>
                    </InfiniteScroll>
                </div>
            </div>
        </div>
    );
}
