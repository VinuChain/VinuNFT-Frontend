import React, { useState } from "react";
import { useEffect } from "react";
import { useReadProvider } from "../common/provider";
import config from "../config";
import {
    blockToDateState,
    computeBalances,
    getBlockTime,
    getEvents,
} from "../common/history";
import Skeleton from "react-loading-skeleton";
import { shortenAddress } from "../common/utils";
import { useRecoilState } from "recoil";

import TimeAgo from "javascript-time-ago";
import en from "javascript-time-ago/locale/en.json";

import Address from "./Address";

TimeAgo.addDefaultLocale(en);

const timeAgo = new TimeAgo("en-US");

export default function NFTHistory({ history, hideId }) {
    const [readProvider] = useReadProvider();
    const [blockToDate, setBlockToDate] = useRecoilState(blockToDateState);

    useEffect(() => {
        if (!history) {
            return;
        }

        for (const event of history) {
            if (!(event.blockNumber in blockToDate)) {
                getBlockTime(readProvider, event.blockNumber).then((date) => {
                    setBlockToDate((prev) => ({
                        ...prev,
                        [event.blockNumber]: date,
                    }));
                });
            }
        }
    }, [history]);

    // console.log(history);

    // parseHistory returns undefined for "not scanned yet" and [] for
    // "scanned, nothing there". Rendering both as a skeleton told a reader
    // with no activity that the page was still loading, forever.
    if (Array.isArray(history) && history.length === 0) {
        return <p className="nft-history-empty">No activity yet.</p>;
    }

    return history ? (
        <div>
            {[...history].reverse().map((event, index) => {
                return (
                    <div className="mb-4" id={index} key={index}>
                        {hideId ? (
                            <></>
                        ) : (
                            <b>
                                {event.id ? (
                                    <tt className="is-size-5">
                                        <a
                                            href={`/nft?type=${event.nftType}&id=${event.id}`}
                                            style={{
                                                textDecoration: "underline",
                                            }}
                                        >
                                            {event.nftType == "image"
                                                ? "IMAGE"
                                                : "TEXT"}{" "}
                                            NFT #{event.id}
                                        </a>
                                    </tt>
                                ) : (
                                    <></>
                                )}
                            </b>
                        )}
                        <div
                            key={index}
                            className="is-flex is-justify-content-space-between is-align-items-center"
                        >
                            <b className="is-size-6">
                                <tt>{event.type.toUpperCase()}</tt>
                            </b>
                            {blockToDate[event.blockNumber] ? (
                                <tt className="is-size-7 mr-2 mt-1">
                                    {timeAgo
                                        .format(blockToDate[event.blockNumber])
                                        .toUpperCase()}
                                </tt>
                            ) : (
                                <Skeleton width={100} />
                            )}
                        </div>
                        <p>
                            {event.from ? (
                                <tt className="is-size-7">
                                    FROM:{" "}
                                    <Address
                                        address={event.from}
                                        shorten
                                        nChar={8}
                                    />
                                </tt>
                            ) : (
                                <></>
                            )}
                        </p>
                        <p>
                            {event.to ? (
                                <tt className="is-size-7">
                                    TO: &nbsp;&nbsp;
                                    <Address
                                        address={event.to}
                                        shorten
                                        nChar={8}
                                    />
                                </tt>
                            ) : (
                                <></>
                            )}
                        </p>
                        <p>
                            {event.seller ? (
                                <tt className="is-size-7">
                                    SELLER:{" "}
                                    <Address
                                        address={event.seller}
                                        shorten
                                        nChar={8}
                                    />
                                </tt>
                            ) : (
                                <></>
                            )}
                        </p>
                        <p>
                            {event.buyer ? (
                                <tt className="is-size-7">
                                    BUYER: &nbsp;
                                    <Address
                                        address={event.buyer}
                                        shorten
                                        nChar={8}
                                    />
                                </tt>
                            ) : (
                                <></>
                            )}
                        </p>
                        <p>
                            {event.price ? (
                                <tt className="is-size-7">
                                    PRICE: &nbsp;{event.price}{" "}
                                    {config.tokens[event.paymentToken]
                                        ?.symbol || "N/A"}
                                </tt>
                            ) : event.type === "list" ||
                              event.type === "purchase" ? (
                                // A priced event whose ERC-20 this app does not
                                // recognise. Its decimals are unknown, so any
                                // figure shown would be a guess; say so rather
                                // than omit the row and imply there was no price.
                                <tt
                                    className="is-size-7"
                                    title="This listing uses a token VinuNFT does not recognise, so its amount cannot be displayed accurately."
                                >
                                    PRICE: &nbsp;unavailable (unrecognised
                                    token)
                                </tt>
                            ) : (
                                <></>
                            )}
                        </p>
                        <p>
                            {event.amount ? (
                                <tt className="is-size-7">
                                    AMOUNT: {event.amount}
                                </tt>
                            ) : (
                                <></>
                            )}
                        </p>
                        <p className="is-size-7">
                            <a
                                target="_blank"
                                rel="noreferrer"
                                style={{ textDecoration: "underline" }}
                                href={
                                    config.blockExplorer.url +
                                    "/tx/" +
                                    event.transactionHash
                                }
                            >
                                <tt>[tx]</tt>
                            </a>
                        </p>
                        <hr />
                    </div>
                );
            })}
        </div>
    ) : (
        <Skeleton />
    );
}
