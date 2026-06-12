import React, { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet";
import { Header } from "../components";
import Address from "../components/Address";
import RoutingLink from "../components/RoutingLink";
import {
    discoverMarketplaceListings,
    MARKETPLACE_DISCOVERY_WINDOW,
    MARKETPLACE_LISTINGS_PER_TOKEN_LIMIT,
} from "../common/marketplaceDiscovery";
import { useReadProvider } from "../common/provider";
import config from "../config";

import "bulma/css/bulma.min.css";
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../styles/globals.css";

function isFulfillable(listing) {
    return (
        listing.sellerBalance !== null &&
        listing.sellerBalance >= listing.amount
    );
}

export default function Marketplace() {
    const [readProvider] = useReadProvider();
    const [listings, setListings] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [nftType, setNftType] = useState("all");
    const [paymentToken, setPaymentToken] = useState("all");
    const [priceSort, setPriceSort] = useState("asc");
    const [fulfillableOnly, setFulfillableOnly] = useState(false);
    const [seller, setSeller] = useState("");

    useEffect(() => {
        let cancelled = false;

        async function loadListings() {
            if (!readProvider) {
                return;
            }

            setLoading(true);
            setError(null);
            try {
                const discovered = await discoverMarketplaceListings(
                    readProvider
                );
                if (!cancelled) {
                    setListings(discovered);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(
                        e.message || "Could not load marketplace listings."
                    );
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        loadListings();
        return () => {
            cancelled = true;
        };
    }, [readProvider]);

    const filteredListings = useMemo(() => {
        const normalizedSeller = seller.trim().toLowerCase();

        return listings
            .filter(
                (listing) => nftType === "all" || listing.nftType === nftType
            )
            .filter(
                (listing) =>
                    paymentToken === "all" ||
                    listing.paymentToken === paymentToken
            )
            .filter((listing) => !fulfillableOnly || isFulfillable(listing))
            .filter(
                (listing) =>
                    !normalizedSeller ||
                    listing.seller.toLowerCase().includes(normalizedSeller)
            )
            .sort((left, right) => {
                const direction = priceSort === "desc" ? -1 : 1;
                return (
                    (parseFloat(left.price) - parseFloat(right.price)) *
                    direction
                );
            });
    }, [listings, nftType, paymentToken, priceSort, fulfillableOnly, seller]);

    return (
        <div>
            <Helmet>
                <title>Marketplace - VinuNFT</title>
            </Helmet>
            <Header />
            <main className="vinunft-page">
                <section className="vinunft-page__header">
                    <p className="vinunft-page__eyebrow">
                        Active listings, bounded by the latest{" "}
                        {MARKETPLACE_DISCOVERY_WINDOW} tokens per type and{" "}
                        {MARKETPLACE_LISTINGS_PER_TOKEN_LIMIT} listings per
                        token
                    </p>
                    <h1 className="title">Marketplace</h1>
                </section>

                <section className="marketplace-filters">
                    <label className="field">
                        <span className="label">NFT type</span>
                        <span className="select">
                            <select
                                value={nftType}
                                onChange={(event) =>
                                    setNftType(event.target.value)
                                }
                            >
                                <option value="all">All</option>
                                <option value="text">Text</option>
                                <option value="image">Image</option>
                            </select>
                        </span>
                    </label>
                    <label className="field">
                        <span className="label">Payment token</span>
                        <span className="select">
                            <select
                                value={paymentToken}
                                onChange={(event) =>
                                    setPaymentToken(event.target.value)
                                }
                            >
                                <option value="all">All</option>
                                {Object.entries(config.tokens).map(
                                    ([tokenId, token]) => (
                                        <option key={tokenId} value={tokenId}>
                                            {token.symbol}
                                        </option>
                                    )
                                )}
                            </select>
                        </span>
                    </label>
                    <label className="field">
                        <span className="label">Price sort</span>
                        <span className="select">
                            <select
                                value={priceSort}
                                onChange={(event) =>
                                    setPriceSort(event.target.value)
                                }
                            >
                                <option value="asc">Low to high</option>
                                <option value="desc">High to low</option>
                            </select>
                        </span>
                    </label>
                    <label className="checkbox marketplace-filters__checkbox">
                        <input
                            type="checkbox"
                            checked={fulfillableOnly}
                            onChange={(event) =>
                                setFulfillableOnly(event.target.checked)
                            }
                        />{" "}
                        Fulfillable only
                    </label>
                    <label className="field marketplace-filters__seller">
                        <span className="label">Seller</span>
                        <input
                            className="input"
                            value={seller}
                            onChange={(event) => setSeller(event.target.value)}
                            placeholder="0x..."
                        />
                    </label>
                </section>

                {error ? (
                    <p className="notification is-danger">{error}</p>
                ) : loading ? (
                    <p>Loading listings...</p>
                ) : filteredListings.length === 0 ? (
                    <p>No listings found in the bounded discovery window.</p>
                ) : (
                    <section className="marketplace-listings">
                        {filteredListings.map((listing) => (
                            <article
                                className="marketplace-listing"
                                key={`${listing.nftType}-${listing.tokenId}-${listing.listingId}`}
                            >
                                <div>
                                    <p className="marketplace-listing__type">
                                        {listing.nftType} NFT
                                    </p>
                                    <RoutingLink
                                        className="marketplace-listing__title"
                                        href={`/nft?type=${listing.nftType}&id=${listing.tokenId}`}
                                    >
                                        #{listing.tokenId}
                                    </RoutingLink>
                                </div>
                                <div>
                                    <p className="marketplace-listing__label">
                                        Price
                                    </p>
                                    <p>
                                        {listing.price}{" "}
                                        {
                                            config.tokens[listing.paymentToken]
                                                .symbol
                                        }
                                    </p>
                                </div>
                                <div>
                                    <p className="marketplace-listing__label">
                                        Amount
                                    </p>
                                    <p>{listing.amount}</p>
                                </div>
                                <div>
                                    <p className="marketplace-listing__label">
                                        Seller
                                    </p>
                                    <Address
                                        address={listing.seller}
                                        shorten
                                        nChar={6}
                                    />
                                </div>
                                <div>
                                    <p className="marketplace-listing__label">
                                        Fulfillability
                                    </p>
                                    <p
                                        className={
                                            isFulfillable(listing)
                                                ? "has-text-success"
                                                : "has-text-warning"
                                        }
                                    >
                                        {isFulfillable(listing)
                                            ? "Fulfillable"
                                            : "Needs seller balance check"}
                                    </p>
                                </div>
                            </article>
                        ))}
                    </section>
                )}
            </main>
        </div>
    );
}
