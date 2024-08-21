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
    const zangAddress = config.contractAddresses.v1.text;
    const zangABI = v1.text;
    const marketplaceAddress = config.contractAddresses.v1.marketplace;
    const marketplaceABI = v1.marketplace;

    const [events, setEvents] = useState(null);

    const [readProvider] = useReadProvider();

    const queryEvents = async () => {
        if (!readProvider) {
            return;
        }

        const nftContract = new ethers.Contract(
            zangAddress,
            zangABI,
            defaultReadProvider
        );
        const marketplaceContract = new ethers.Contract(
            marketplaceAddress,
            marketplaceABI,
            defaultReadProvider
        );
        const firstNftBlock = config.firstBlocks.v1.text;
        const firstMarketplaceBlock = config.firstBlocks.v1.marketplace;

        const events = await getAllEvents(
            nftContract,
            marketplaceContract,
            firstNftBlock,
            firstMarketplaceBlock
        );
        console.log("events", events);
        setEvents(events);
    };

    useEffect(async () => {
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
                    <h1 className="title has-text-centered">Recent activity</h1>
                    <NFTHistory history={parseHistory(events)} />
                </div>
            </div>
        </>
    );
}
