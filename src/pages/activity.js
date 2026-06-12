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
import NFTHistory from "../components/NFTHistory";

export default function Activity() {
    const [events, setEvents] = useState(null);

    const [readProvider] = useReadProvider();

    const queryEvents = async () => {
        if (!readProvider) {
            return;
        }

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

        // console.log("events", allEvents);
        setEvents(allEvents);
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
                    <NFTHistory history={parseHistory(events)} />
                </div>
            </div>
        </>
    );
}
