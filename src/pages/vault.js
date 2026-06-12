import React, { useEffect, useState } from "react";
import { useReadProvider, useWalletProvider } from "../common/provider";
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
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../styles/globals.css";

export default function Vault() {
    const [readProvider] = useReadProvider();
    const [walletProvider] = useWalletProvider();
    const [lastTextNFTId, setLastTextNFTId] = useState(null);
    const [lastImageNFtId, setLastImageNFTId] = useState(null);
    const [textNfts, setTextNFTs] = useState([]);
    const [imageNfts, setImageNFTs] = useState([]);
    const [nftToBalance, setNftToBalance] = useState({ text: {}, image: {} });
    const [walletAddress, setWalletAddress] = useState(null);

    const [, setStandardError] = useRecoilState(standardErrorState);

    const increment = 5;

    useEffect(() => {
        if (!walletProvider) {
            return;
        }
        async function setInfo() {
            try {
                const newWalletAddress = await walletProvider
                    .getSigner()
                    .getAddress();
                setWalletAddress(newWalletAddress);

                // Reset NFTs, since we don't know which ones we have
                setTextNFTs([]);
                setImageNFTs([]);

                setNftToBalance({ text: {}, image: {} });
                for (const type of ["text", "image"]) {
                    for (const nftId of Object.keys(nftToBalance[type])) {
                        updateNftToBalance(type, nftId, newWalletAddress);
                    }
                }
            } catch (e) {
                console.log(e);
                setStandardError(formatError(e));
            }
        }
        setInfo();
    }, [walletProvider]);

    async function preparePage() {
        const textNftContract = new ethers.Contract(
            config.contractAddresses.v1.text,
            v1.text,
            readProvider
        );

        const imageNftContract = new ethers.Contract(
            config.contractAddresses.v1.image,
            v1.image,
            readProvider
        );

        try {
            const newLastTextNFTId = await textNftContract.lastTokenId();
            const newLastImageNFTId = await imageNftContract.lastTokenId();
            setLastTextNFTId(newLastTextNFTId.toNumber());
            setLastImageNFTId(newLastImageNFTId.toNumber());
        } catch (e) {
            console.log(e);
            setStandardError(formatError(e));
        }
    }

    useEffect(() => {
        preparePage();
    }, []);

    const updateNftToBalance = async (type, nftId, address) => {
        await updateNftBalances(type, [nftId], address);
    };

    const updateNftBalances = async (type, nftIds, address) => {
        if (!address || nftIds.length === 0) {
            return;
        }

        const contractAddress = config.contractAddresses.v1[type];
        const contractABI = v1[type];
        const contract = new ethers.Contract(
            contractAddress,
            contractABI,
            readProvider
        );

        try {
            const balances = await Promise.all(
                nftIds.map(async (nftId) => [
                    nftId,
                    (await contract.balanceOf(address, nftId)).toNumber(),
                ])
            );

            setNftToBalance((currentNftToBalance) => ({
                ...currentNftToBalance,
                [type]: {
                    ...currentNftToBalance[type],
                    ...Object.fromEntries(balances),
                },
            }));
        } catch (e) {
            console.log(e);
            setStandardError(formatError(e));
        }
    };

    const getMoreIds = async (count, address) => {
        if (!address) {
            return;
        }

        const newTextNFTs = [...textNfts];
        const newImageNFTs = [...imageNfts];
        const textIdsToQuery = [];
        const imageIdsToQuery = [];

        for (let i = 0; i < count; i++) {
            const newTextId = lastTextNFTId - newTextNFTs.length;
            const newImageId = lastImageNFtId - newImageNFTs.length;
            if (newTextId >= 1) {
                newTextNFTs.push(newTextId);
                textIdsToQuery.push(newTextId);
            }
            if (newImageId >= 1) {
                newImageNFTs.push(newImageId);
                imageIdsToQuery.push(newImageId);
            }
        }

        setTextNFTs(newTextNFTs);
        setImageNFTs(newImageNFTs);
        await Promise.all([
            updateNftBalances("text", textIdsToQuery, address),
            updateNftBalances("image", imageIdsToQuery, address),
        ]);
    };

    useEffect(() => {
        getMoreIds(20, walletAddress);
    }, [lastTextNFTId, walletAddress]);

    const interleavedNfts = [];

    for (let i = 0; i < Math.max(textNfts.length, imageNfts.length); i++) {
        if (i < textNfts.length) {
            interleavedNfts.push(["text", textNfts[i]]);
        }
        if (i < imageNfts.length) {
            interleavedNfts.push(["image", imageNfts[i]]);
        }
    }

    const filteredNfts = interleavedNfts.filter(
        ([type, nftId]) =>
            nftToBalance[type][nftId] !== undefined &&
            nftToBalance[type][nftId] !== 0
    );

    useEffect(() => {
        if (
            filteredNfts.length < 20 &&
            (textNfts.length < lastTextNFTId ||
                imageNfts.length < lastImageNFtId)
        ) {
            getMoreIds(20, walletAddress);
        }
    }, [interleavedNfts, walletAddress]);

    return (
        <div>
            <Helmet>
                <title>Vault - VinuNFT</title>
            </Helmet>
            <Header />
            <StandardErrorDisplay />
            <div className="columns m-4">
                <div className="column">
                    <h1 className="title has-text-centered">Owned NFTs</h1>
                    {walletAddress ? (
                        <InfiniteScroll
                            dataLength={interleavedNfts.length}
                            next={() => getMoreIds(increment, walletAddress)}
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
                                {filteredNfts.map(([type, id]) => (
                                    <NFTCard
                                        id={id}
                                        key={type + "-" + id}
                                        type={type}
                                    />
                                ))}
                            </div>
                        </InfiniteScroll>
                    ) : (
                        <p className="has-text-centered">
                            Connect a wallet to view owned NFTs
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
