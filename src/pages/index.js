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
    const [nfts, setNFTs] = useState([]);

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
        const newNFTs = [...nfts];

        for (let i = 0; i < count; i++) {
            const newTextNftId = lastTextNFTId - newNFTs.length;
            if (newTextNftId >= 1) {
                newNFTs.push({ type: "text", id: newTextNftId });
            }
            const newImageNftId = lastImageNFtId - newNFTs.length;
            if (newImageNftId >= 1) {
                newNFTs.push({ type: "image", id: newImageNftId });
            }
        }

        setNFTs(newNFTs);
    };

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
                        dataLength={nfts.length}
                        next={() => getMoreIds(increment)}
                        hasMore={nfts.length < lastTextNFTId}
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
                            {nfts.map(({ id, type }) => (
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
