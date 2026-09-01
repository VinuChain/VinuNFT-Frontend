import React, { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet";
import { ethers } from "ethers";
import { Header } from "../components";
import Address from "../components/Address";
import RoutingLink from "../components/RoutingLink";
import { lag } from "../common/indexer";
import { listingRowsFromIndex, loadIndex } from "../common/indexLoader";
import { marketplaceMetrics } from "../common/marketplaceAnalytics";
import {
    LISTINGS_PAGE_SIZE,
    compareListingRows,
    listingRowKey,
    pageListings,
    rowMatchesFilters,
} from "../common/marketplaceDiscovery";
import { useReadProvider } from "../common/provider";
import { formatTokenAmount } from "../common/utils";
import config from "../config";

import "bulma/css/bulma.min.css";
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../styles/globals.css";

/**
 * What this page's listing set actually covers, in one sentence.
 *
 * The index is a fold over every marketplace event from the contract's first
 * block, so the honest claim is "every active listing" — but only as of the
 * block it was scanned to, and only for rows this app can link. Both caveats
 * are stated rather than left to the reader.
 */
function coverageLine(coverage) {
    if (!coverage) {
        return "Indexing every marketplace event...";
    }

    const behind = coverage.lag
        ? `${coverage.lag.blocks}`
        : "an unknown number of";

    return (
        `Every active listing, indexed from all marketplace events through ` +
        `block ${coverage.indexedThrough} (${behind} blocks behind the head)` +
        (coverage.unknownCollection > 0
            ? `. ${coverage.unknownCollection} not shown: on a collection this app cannot render`
            : "") +
        (coverage.unrecognisedPaymentToken > 0
            ? `. ${coverage.unrecognisedPaymentToken} shown without a price: listed in an ERC-20 this app does not recognise`
            : "")
    );
}

/**
 * Availability as three distinct facts, not two.
 *
 * A seller whose balance is KNOWN and short is a settled fact; a seller whose
 * balance could not be read is an open question. Collapsing them into one
 * "needs checking" string presents the settled case as unchecked.
 */
function availability(listing) {
    if (listing.sellerBalance === null) {
        return {
            label: "Seller balance unavailable",
            tone: "has-text-warning",
        };
    }
    if (listing.sellerBalance >= listing.amount) {
        return { label: "Fulfillable", tone: "has-text-success" };
    }
    return {
        label: `Seller holds only ${listing.sellerBalance} of ${listing.amount}`,
        tone: "has-text-danger",
    };
}

const symbolOf = (paymentToken) => config.tokens[paymentToken]?.symbol ?? "";

const amount = (raw, paymentToken) =>
    `${formatTokenAmount(raw, paymentToken)} ${symbolOf(paymentToken)}`;

function Metric({ label, value, note }) {
    return (
        <div className="marketplace-metric">
            <p className="marketplace-metric__label">{label}</p>
            <p className="marketplace-metric__amount">{value}</p>
            {note ? <p className="marketplace-metric__note">{note}</p> : null}
        </div>
    );
}

function Count({ label, value }) {
    return (
        <div className="marketplace-metric">
            <p className="marketplace-metric__label">{label}</p>
            <p className="marketplace-metric__count">{value}</p>
        </div>
    );
}

/**
 * Every figure here is exact and keyed by payment token.
 *
 * Nothing is averaged, smoothed, projected or converted. The two families that
 * cannot be defined in this product are named in the closing paragraph rather
 * than approximated: see docs/marketplace-discovery.md for why.
 */
function Metrics({ metrics, coverage }) {
    const buckets = Object.values(metrics.byPaymentToken);

    return (
        <section className="marketplace-metrics">
            <h2 className="title is-5">
                Marketplace activity, as of block {coverage.indexedThrough}
            </h2>
            <p className="marketplace-metrics__definitions">
                Every figure below is derived from the complete marketplace
                event history and is stated in one payment token. Volume is the
                sum of the per-unit price times the units sold, over every sale
                ever executed. Fees, royalties and proceeds are the three legs
                of each sale, derived from the fee rate and the royalty read at
                that sale&apos;s own block, and checked against the ERC-20
                transfers the buyer actually paid.
            </p>

            {buckets.map((bucket) => {
                const token = bucket.paymentToken;
                const covered =
                    bucket.salesCount - bucket.salesMissingSettlement;
                return (
                    <article className="marketplace-metrics__token" key={token}>
                        <h3 className="title is-6">{symbolOf(token)}</h3>
                        <div className="marketplace-metrics__grid">
                            <Metric
                                label="Traded volume"
                                value={amount(bucket.volume, token)}
                            />
                            <Count label="Sales" value={bucket.salesCount} />
                            <Count
                                label="Units sold"
                                value={bucket.unitsSold}
                            />
                            {covered > 0 ? (
                                <>
                                    <Metric
                                        label="Platform fees"
                                        value={amount(
                                            bucket.platformFees,
                                            token
                                        )}
                                        note={`over ${covered} of ${bucket.salesCount} sales; ${bucket.settlementsReconciled} reconcile against their receipt`}
                                    />
                                    <Metric
                                        label="Creator royalties"
                                        value={amount(bucket.royalties, token)}
                                        note={`over ${covered} of ${bucket.salesCount} sales`}
                                    />
                                    <Metric
                                        label="Seller proceeds"
                                        value={amount(
                                            bucket.sellerProceeds,
                                            token
                                        )}
                                        note={`over ${covered} of ${bucket.salesCount} sales`}
                                    />
                                </>
                            ) : bucket.salesCount > 0 ? (
                                <p className="marketplace-metric__note">
                                    Fee split unavailable: the historical reads
                                    for {bucket.salesCount} sale
                                    {bucket.salesCount === 1 ? "" : "s"} did not
                                    succeed, so no split is shown. The sales
                                    still count toward volume.
                                </p>
                            ) : null}
                            {bucket.lastSale ? (
                                <Metric
                                    label="Last sale price"
                                    value={amount(bucket.lastSale.price, token)}
                                    note={`per unit, block ${bucket.lastSale.block}`}
                                />
                            ) : null}
                            {bucket.floorUnitPrice ? (
                                <Metric
                                    label="Lowest active listing price"
                                    value={amount(bucket.floorUnitPrice, token)}
                                    note={`per unit, across ${
                                        bucket.activeListings
                                    } active listing${
                                        bucket.activeListings === 1 ? "" : "s"
                                    }, whether or not the seller still holds the units`}
                                />
                            ) : (
                                <p className="marketplace-metric__note">
                                    No active listing in {symbolOf(token)}, so
                                    there is no lowest price to state.
                                </p>
                            )}
                            <Count
                                label="Active listings"
                                value={bucket.activeListings}
                            />
                        </div>
                    </article>
                );
            })}

            <div className="marketplace-metrics__grid">
                <Count
                    label="Listings created"
                    value={metrics.listingsCreated}
                />
                <Count label="Active listings" value={metrics.activeListings} />
                <Count label="Distinct buyers" value={metrics.buyers} />
                <Count label="Distinct sellers" value={metrics.sellers} />
            </div>
            <p className="marketplace-metrics__note">
                Listings created counts distinct listings, not listing events:
                editing a listing re-emits the same event under the same id.
                {metrics.unpricedActiveListings > 0
                    ? ` ${metrics.unpricedActiveListings} active listing(s) are priced in an unrecognised ERC-20 and are excluded from every figure above, including the lowest price.`
                    : ""}
                {metrics.unpricedSales > 0
                    ? ` ${metrics.unpricedSales} sale(s) settled in an unrecognised ERC-20 and are counted but not valued.`
                    : ""}
            </p>
            <p className="marketplace-metrics__note">
                No figure combines payment tokens: this product integrates no
                price oracle, so amounts in different ERC-20s are never added
                together or ranked against one another. No movement-over-time
                figure is published either, because it would need a defined
                window that the data does not supply.
            </p>
        </section>
    );
}

export default function Marketplace() {
    const [readProvider] = useReadProvider();
    const [listings, setListings] = useState([]);
    const [metrics, setMetrics] = useState(null);
    const [coverage, setCoverage] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [reloads, setReloads] = useState(0);
    const [nftType, setNftType] = useState("all");
    const [paymentToken, setPaymentToken] = useState("all");
    const [priceSort, setPriceSort] = useState("asc");
    const [fulfillableOnly, setFulfillableOnly] = useState(false);
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(null);

    useEffect(() => {
        let cancelled = false;

        async function loadListings() {
            if (!readProvider) {
                return;
            }

            setLoading(true);
            setError(null);
            try {
                const { state, headBlock, formats } = await loadIndex(
                    readProvider
                );
                const { rows, unrecognisedPaymentToken, unknownCollection } =
                    listingRowsFromIndex(state, formats);
                if (!cancelled) {
                    setListings(rows);
                    setMetrics(marketplaceMetrics(state));
                    setCoverage({
                        indexedThrough: state.lastIndexedBlock,
                        lag: lag(state, headBlock),
                        unrecognisedPaymentToken,
                        unknownCollection,
                    });
                }
            } catch (e) {
                if (!cancelled) {
                    // A partial view is the failure this branch exists to
                    // prevent: drop the listings AND the figures, or the page
                    // shows a marketplace smaller than the real one.
                    setListings([]);
                    setMetrics(null);
                    setCoverage(null);
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
    }, [readProvider, reloads]);

    // One filter implementation, shared with every other consumer and with the
    // tests. The page used to re-implement all four predicates and disagree
    // with the module on an unknown seller balance.
    const filteredListings = useMemo(() => {
        const filters = {
            nftType,
            paymentToken,
            fulfillableOnly,
            query,
        };
        const direction = priceSort === "desc" ? -1 : 1;
        return listings
            .filter((listing) => rowMatchesFilters(listing, filters))
            .sort((left, right) => compareListingRows(left, right) * direction);
    }, [listings, nftType, paymentToken, priceSort, fulfillableOnly, query]);

    // A cursor names a row. Changing the filters can remove that row, and a
    // page anchored to a row that is gone would restart silently, so the reset
    // is explicit.
    useEffect(() => {
        setCursor(null);
    }, [nftType, paymentToken, priceSort, fulfillableOnly, query]);

    const page = useMemo(
        () => pageListings(filteredListings, { cursor }),
        [filteredListings, cursor]
    );

    return (
        <div>
            <Helmet>
                <title>Marketplace - VinuNFT</title>
            </Helmet>
            <Header />
            <main className="vinunft-page">
                <section className="vinunft-page__header">
                    <p className="vinunft-page__eyebrow">
                        {error
                            ? "Index scan failed - listing coverage is unknown"
                            : coverageLine(coverage)}
                    </p>
                    <h1 className="title">Marketplace</h1>
                    <button
                        className="button is-small"
                        type="button"
                        disabled={loading}
                        onClick={() => setReloads((n) => n + 1)}
                    >
                        Refresh
                    </button>
                </section>

                <section className="marketplace-filters">
                    <label className="field marketplace-filters__search">
                        <span className="label">Search</span>
                        <input
                            className="input"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Token id or 0x seller"
                        />
                    </label>
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
                </section>

                {error ? (
                    <p className="notification is-danger">{error}</p>
                ) : loading ? (
                    <p>Loading listings...</p>
                ) : (
                    <>
                        {metrics ? (
                            <Metrics metrics={metrics} coverage={coverage} />
                        ) : null}

                        {filteredListings.length === 0 ? (
                            <p>
                                No listings match. The index holds{" "}
                                {listings.length} active listing
                                {listings.length === 1 ? "" : "s"}.
                            </p>
                        ) : (
                            <>
                                <p className="marketplace-listings__count">
                                    Showing {page.rows.length} of{" "}
                                    {filteredListings.length} listings
                                </p>
                                <section className="marketplace-listings">
                                    {page.rows.map((listing) => (
                                        <Listing
                                            key={listingRowKey(listing)}
                                            listing={listing}
                                        />
                                    ))}
                                </section>
                                {page.nextCursor ? (
                                    <button
                                        className="button"
                                        type="button"
                                        onClick={() =>
                                            setCursor(page.nextCursor)
                                        }
                                    >
                                        Load more
                                    </button>
                                ) : null}
                            </>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}

function Listing({ listing }) {
    const state = availability(listing);
    const priced = listing.paymentToken !== null;

    return (
        <article className="marketplace-listing">
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
                <p className="marketplace-listing__format">
                    {listing.format ?? "Format unavailable"}
                </p>
            </div>
            <div>
                <p className="marketplace-listing__label">Price (per unit)</p>
                {priced ? (
                    <>
                        <p>
                            {listing.price} {symbolOf(listing.paymentToken)}
                        </p>
                        {/* The contract charges price x amount, so the lot cost
                            is stated too: a bare unit price beside "Amount 3"
                            reads as the total. */}
                        <p className="marketplace-listing__total">
                            Total for {listing.amount}:{" "}
                            {amount(
                                ethers.BigNumber.from(listing.priceRaw).mul(
                                    listing.amount
                                ),
                                listing.paymentToken
                            )}
                        </p>
                    </>
                ) : (
                    <>
                        <p>unavailable (unrecognised token)</p>
                        <Address
                            address={listing.paymentTokenAddress}
                            shorten
                            nChar={6}
                        />
                    </>
                )}
            </div>
            <div>
                <p className="marketplace-listing__label">Amount</p>
                <p>{listing.amount}</p>
            </div>
            <div>
                <p className="marketplace-listing__label">Supply</p>
                <p>{listing.supply ?? "unknown"}</p>
            </div>
            <div>
                <p className="marketplace-listing__label">Seller</p>
                <Address address={listing.seller} shorten nChar={6} />
            </div>
            <div>
                <p className="marketplace-listing__label">Creator</p>
                {listing.creator ? (
                    <Address address={listing.creator} shorten nChar={6} />
                ) : (
                    <p>unknown</p>
                )}
            </div>
            <div>
                <p className="marketplace-listing__label">Fulfillability</p>
                <p
                    className={`marketplace-listing__availability ${state.tone}`}
                >
                    {state.label}
                </p>
            </div>
        </article>
    );
}
