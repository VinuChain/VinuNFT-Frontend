import React, { useEffect } from "react";
import { useState } from "react";
import { Header } from "../components";

import config from "../config";
import { v1 } from "../common/abi";

import {
    defaultReadProvider,
    useReadProvider,
    useWalletProvider,
} from "../common/provider";
import { ethers } from "ethers";
import { getAllEvents, parseHistory } from "../common/history";
import { formatError } from "../common/error";
import { coverageSentence } from "../common/utils";
import NFTHistory from "../components/NFTHistory";

export default function Activity() {
    const [events, setEvents] = useState(null);
    // The scan had no error handling at all: a failed RPC left `events` null
    // forever, and NFTHistory renders null as a skeleton — a page that looks
    // like it is still loading, permanently, with nothing to retry.
    const [error, setError] = useState(null);
    // The feed scans to the head at query time, so the head has moved by the
    // time it renders. Both blocks are read, so the lag shown is measured
    // rather than assumed to be zero.
    const [coverage, setCoverage] = useState(null);

    const [readProvider] = useReadProvider();

    const queryEvents = async () => {
        if (!readProvider) {
            return;
        }

        setError(null);
        setEvents(null);
        setCoverage(null);

        const textNftContract = new ethers.Contract(
            config.contractAddresses.v1.text,
            v1.text,
            defaultReadProvider
        );

        const imageNftContract = new ethers.Contract(
            config.contractAddresses.v1.image,
            v1.image,
            defaultReadProvider
        );

        const marketplaceContract = new ethers.Contract(
            config.contractAddresses.v1.marketplace,
            v1.marketplace,
            defaultReadProvider
        );
        const firstMarketplaceBlock = config.firstBlocks.v1.marketplace;

        try {
            const headBlock = await defaultReadProvider.getBlockNumber();
            const textEvents = await getAllEvents(
                textNftContract,
                marketplaceContract,
                config.firstBlocks.v1.text,
                firstMarketplaceBlock
            );

            const imageEvents = await getAllEvents(
                imageNftContract,
                marketplaceContract,
                config.firstBlocks.v1.image,
                firstMarketplaceBlock
            );

            const allEvents = [];

            for (const event of textEvents) {
                allEvents.push({ ...event, nftType: "text" });
            }
            for (const event of imageEvents) {
                allEvents.push({ ...event, nftType: "image" });
            }

            allEvents.sort((a, b) => a.blockNumber - b.blockNumber);

            setEvents(allEvents);
            setCoverage({
                scannedThrough: headBlock,
                lag: (await defaultReadProvider.getBlockNumber()) - headBlock,
            });
        } catch (e) {
            // Naming the failure is the point: an empty feed and an unreachable
            // node look identical, and only one of them is worth retrying.
            setError(formatError(e));
        }
    };

    useEffect(() => {
        queryEvents();
    }, [readProvider]);

    return (
        <>
            <Header />
            <div className="is-flex is-justify-content-center">
                <div
                    className="px-6 is-flex is-flex-direction-column is-justify-content-center"
                    style={{ maxWidth: "100ch", minWidth: "50vw" }}
                >
                    <h1 className="title has-text-centered">Recent Activity</h1>
                    <p className="has-text-centered nft-index-coverage">
                        {error
                            ? "Scan failed - activity coverage is unknown"
                            : coverageSentence(
                                  "every mint, transfer, listing and sale",
                                  coverage?.scannedThrough ?? null,
                                  coverage?.lag
                              )}
                    </p>
                    {error ? (
                        <div className="has-text-centered">
                            <p className="nft-scan-error">
                                Activity could not be loaded: {error}
                            </p>
                            <button
                                className="button is-small"
                                onClick={queryEvents}
                            >
                                Retry
                            </button>
                        </div>
                    ) : (
                        <NFTHistory history={parseHistory(events)} />
                    )}
                </div>
            </div>
        </>
    );
}
