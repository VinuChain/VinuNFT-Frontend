import React from "react";
import { useEffect, useState } from "react";
import { atom, useRecoilState } from "recoil";
import {
    defaultReadProvider,
    useReadProvider,
    useWalletProvider,
} from "../../common/provider";
import config from "../../config";
import { ethers } from "ethers";
import { v1 } from "../../common/abi";
import * as queryString from "query-string";
import { socialPreview, parseNftRoute } from "../../common/socialPreview";

import HTMLViewer from "../../components/HTMLViewer";
import MarkdownViewer from "../../components/MarkdownViewer";
import { Helmet } from "react-helmet";
import { Header } from "../../components";

import "bulma/css/bulma.min.css";
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../../styles/globals.css";
import Listings from "../../components/Listings";
import TransferButton from "../../components/TransferButton";
import { useEns } from "../../common/ens";
import TypeTag from "../../components/TypeTag";
import BurnButton from "../../components/BurnButton";
import Decimal from "decimal.js";
import {
    formatError,
    isTokenExistenceError,
    standardErrorState,
} from "../../common/error";
import StandardErrorDisplay from "../../components/StandardErrorDisplay";
import NFTOwners from "../../components/NFTOwners";

import Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";

import {
    getEvents,
    computeBalances,
    parseHistory,
    getNftAuthor,
} from "../../common/history";
import { formatTokenAmount } from "../../common/utils";
import NFTHistory from "../../components/NFTHistory";

import Address from "../../components/Address";
import {
    getTokenAllowances,
    tokenAddressToId,
    tokenAllowancesState,
} from "../../common/user";
import { fetchTokenMetadata, getTokenContent } from "../../common/nftInfo";
import {
    contentDecision,
    visibleListings,
    REPORT_URL,
} from "../../common/contentPolicy";
import ContentNotice from "../../components/ContentNotice";
import { queryFilterChunked } from "../../common/eventScan";

// Fixed, non-derived copy. A media or metadata failure must never echo the
// token's own strings back into the page, and the viewer needs to be able to
// tell "we could not get this" from "still loading".
const METADATA_UNAVAILABLE = "Metadata unavailable";
const MEDIA_UNAVAILABLE =
    "This NFT's media could not be loaded from any configured source.";
const NO_MEDIA = "This NFT's metadata names no media to display.";
// The creator is what an address-scoped blocklist entry is matched against, so
// a creator that could not be read is a policy question with no answer yet.
const CREATOR_UNCHECKED =
    "This NFT's creator could not be read, so its media has not been checked against the content policy and was not fetched.";

/** Enter and Space, which a native button gets for free and an anchor does not. */
const activateOnKey = (event, activate) => {
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
    }
};

const burnedIdsState = atom({
    key: "burnedIds",
    default: [],
});

const styles = {
    arrowContainer: {
        display: "flex",
        justifyContent: "flex-end",
        marginTop: "1em",
        height: "2em",
    },
    arrow: {
        fontSize: "2em",
        marginRight: "0.75em",
    },
};

export default function NFTPage(props) {
    // Every value below is scoped to one token and arrives from a read that
    // resolves later. React keeps this component mounted across a client-side
    // navigation, so a slow answer for the token the user left used to land in
    // the token they are now on — the page showed token 2's id beside token 1's
    // edition size. Keying on the route discards the whole tree instead, which
    // is correct for every read at once rather than a guard per setter. The
    // guard that used to try was commented out below the reads it protected.
    const { type, id } = parseNftRoute(
        queryString.parse(props.location.search)
    );
    return <NFTDetail {...props} key={`${type}:${id}`} />;
}

function NFTDetail({ location }) {
    const [readProvider] = useReadProvider();
    const [walletProvider] = useWalletProvider();
    const marketplaceAddress = config.contractAddresses.v1.marketplace;
    const marketplaceABI = v1.marketplace;

    const parsedQuery = queryString.parse(location.search);
    // parseInt("5abc") is 5 and parseInt("-1") is -1, so the page used to read
    // a token the URL never named; an unrecognised type built a contract at
    // address `undefined` and threw inside the async reads. One parser, shared
    // with the social preview, so the two cannot disagree about the same URL.
    const { type: macroNftType, id } = parseNftRoute(parsedQuery);

    const nftAddress = config.contractAddresses.v1[macroNftType];
    const nftABI = v1[macroNftType];

    const marketplaceContract = new ethers.Contract(
        marketplaceAddress,
        marketplaceABI,
        readProvider
    );

    const [updateTracker, setUpdateTracker] = useState([0, null]);

    const { lookupEns } = useEns();

    const [burnedIds, setBurnedIds] = useRecoilState(burnedIdsState);
    const [prevValidId, setPrevValidId] = useState(null);
    const [nextValidId, setNextValidId] = useState(null);

    // === NFT Info ===

    const [tokenData, setTokenData] = useState(null);
    const [metadataSource, setMetadataSource] = useState(null);
    const [metadataError, setMetadataError] = useState(null);
    const [mediaError, setMediaError] = useState(null);
    // Bumped by the retry control; the load effect already refetches everything.
    const [reload, setReload] = useState(0);
    // Gatsby renders this page statically with no query string, so anything
    // derived from the route differs between the server HTML and the first
    // client render. Every other value on this page is state — null on both
    // sides — which is why only the provenance block needs this.
    const [routeKnown, setRouteKnown] = useState(false);
    const [tokenType, setTokenType] = useState(null);
    const [tokenContent, setTokenContent] = useState(null);
    const [tokenAuthor, setTokenAuthor] = useState(null);
    // Null author means two different things — "not read yet" and "no author" —
    // and the policy has to tell them apart, so the read records that it ran.
    const [authorRead, setAuthorRead] = useState(false);
    // Derived from the validated route and the on-chain author only. Never from
    // metadata: the metadata is what an entry usually exists to suppress, so
    // trusting it to decide suppression would let the token opt itself out.
    // `contentHidden` is a tri-state: null until the author read lands.
    const { status: policyStatus, hidden: contentHidden } = contentDecision(
        {
            nftType: macroNftType,
            tokenId: id,
            addresses: [tokenAuthor],
        },
        { creatorKnown: authorRead }
    );
    const [royaltyInfo, setRoyaltyInfo] = useState(null);
    const [totalSupply, setTotalSupply] = useState(null);
    const [lastNFTId, setLastNFTId] = useState(null);
    const [exists, setExists] = useState(true);
    const [listings, setListings] = useState(null);

    const [walletAddress, setWalletAddress] = useState(null);

    // Owners tab or History tab
    const [isOwners, setIsOwners] = useState(true);
    const setOwners = () => setIsOwners(true);
    const setHistory = () => setIsOwners(false);
    const [events, setEvents] = useState(null);

    const [tokenAllowances, setTokenAllowances] =
        useRecoilState(tokenAllowancesState);

    const [, setStandardError] = useRecoilState(standardErrorState);

    const queryBalances = async (author) => {
        if (!readProvider || !id || !author) {
            return;
        }
        const marketplaceContract = new ethers.Contract(
            marketplaceAddress,
            marketplaceABI,
            defaultReadProvider
        );
        const firstMarketplaceBlock = config.firstBlocks.v1.marketplace;
        const firstNftBlock = config.firstBlocks.v1[macroNftType];
        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            readProvider
        );

        const events = await getEvents(
            id,
            nftContract,
            marketplaceContract,
            author,
            firstNftBlock,
            firstMarketplaceBlock
        );
        // console.log("Find events", events, id, author);
        setEvents(events);
    };

    const queryPrevValidId = async () => {
        if (!id) {
            return;
        }

        let prevId = id - 1;
        let isValid = false;
        while (prevId >= 1 && !isValid) {
            if (burnedIds.includes(prevId)) {
                prevId--;
            } else {
                try {
                    const nftContract = new ethers.Contract(
                        nftAddress,
                        nftABI,
                        readProvider
                    );
                    isValid = await nftContract.exists(prevId);
                } catch (e) {
                    console.log(e);
                    setStandardError(formatError(e));
                    break;
                }

                if (isValid) {
                    break;
                } else {
                    setBurnedIds((burnedIds) => [...burnedIds, prevId]);
                    prevId--;
                }
            }
        }

        if (isValid) {
            return prevId;
        } else {
            return null;
        }
    };

    const queryLastNFTId = async () => {
        if (!readProvider || !nftAddress) return;
        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            readProvider
        );
        try {
            const newLastNFTId = await nftContract.lastTokenId();
            setLastNFTId(newLastNFTId.toNumber());
            return newLastNFTId.toNumber();
        } catch (e) {
            console.log(e);
            setStandardError(formatError(e));
        }
    };

    const queryNextValidId = async () => {
        if (!id || !readProvider) return;

        let nextId = id + 1;
        let isValid = false;
        let actualLastNFTId = lastNFTId;

        if (actualLastNFTId === null) {
            actualLastNFTId = await queryLastNFTId();
        }

        while (nextId <= actualLastNFTId && !isValid) {
            if (nextId == actualLastNFTId) {
                // console.log("Querying...");
                await queryLastNFTId();
            }
            if (burnedIds.includes(nextId)) {
                nextId++;
            } else {
                const nftContract = new ethers.Contract(
                    nftAddress,
                    nftABI,
                    readProvider
                );
                try {
                    isValid = await nftContract.exists(nextId);
                } catch (e) {
                    console.log(e);
                    setStandardError(formatError(e));
                    break;
                }

                if (isValid) {
                    break;
                } else {
                    setBurnedIds((burnedIds) => [...burnedIds, nextId]);
                    nextId++;
                }
            }
        }

        if (isValid) {
            return nextId;
        } else {
            return null;
        }
    };

    const queryTokenURI = async () => {
        if (!id || !readProvider) return;

        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            readProvider
        );
        try {
            const tURI = await nftContract.uri(id);
            return tURI;
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

        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            readProvider
        );
        try {
            const author = await getNftAuthor(nftContract, id);
            setTokenAuthor(author);
            // This read answered the same question a concurrent one may have
            // just failed. Clearing only that error: a metadata or media
            // failure is a different fact, and the render prefers mediaError
            // over the content, so a stale one hides media this page went on
            // to fetch.
            setMediaError((current) =>
                current === CREATOR_UNCHECKED ? null : current
            );
            // Only here. A read that FAILED leaves the decision open on
            // purpose: an unknown creator is not "a creator no entry names",
            // and resolving it to that would let one flaky RPC response switch
            // creator-scoped suppression off and fetch the media anyway.
            setAuthorRead(true);
            return author;
        } catch (e) {
            if (!isTokenExistenceError(e)) {
                console.log(e);
                setStandardError(formatError(e));
            }
            setTokenAuthor(null);
            // Cleared TOGETHER, always. This read also re-runs on every
            // `updateTracker` tick, so a failure here can follow a success:
            // clearing the author while leaving the decision "known" would turn
            // an already-hidden token into a shown one and fetch its media.
            setAuthorRead(false);
            // Undecided is not a skeleton forever: this is the page's ordinary
            // media-failure state, and its Retry re-runs the read.
            setMediaError(CREATOR_UNCHECKED);
            return null;
        }
    };

    const queryTokenData = async (tURI) => {
        if (!tURI) return;

        try {
            const result = await fetchTokenMetadata(tURI);
            setTokenData(result.metadata);
            setMetadataSource(result);

            return result.metadata;
        } catch (e) {
            console.log(e);
            // A metadata failure is this token's problem, not the page's, so it
            // gets a terminal state of its own instead of the global banner —
            // which would otherwise report an error the rest of the page has
            // recovered from. No metadata also means no media to reach.
            setMetadataError(METADATA_UNAVAILABLE);
            setMediaError(MEDIA_UNAVAILABLE);
        }
    };

    const queryTokenContent = async (newTokenData) => {
        if (!newTokenData) return;
        // A hidden item's media is not merely not rendered: it is not fetched.
        // Nothing is gained by pulling the bytes of an unlawful image into the
        // viewer's browser and then declining to paint them. `!== false` and
        // not a falsy check: an undecided policy is not permission, and the
        // effect below re-runs this once the creator read has landed.
        if (contentHidden !== false) return;

        try {
            const tokenContent = await getTokenContent(
                macroNftType,
                newTokenData
            );
            if (tokenContent.exists) {
                setTokenContent(tokenContent.content);
                setTokenType(tokenContent.tokenType);
            } else {
                setMediaError(NO_MEDIA);
            }
        } catch (e) {
            console.log(e);
            // UnsupportedMediaSource and MediaTooLarge carry accurate,
            // token-free sentences; anything else could be a raw fetch message.
            setMediaError(
                e?.name === "UnsupportedMediaSource" ||
                    e?.name === "MediaTooLarge"
                    ? e.message
                    : MEDIA_UNAVAILABLE
            );
        }
    };

    const queryRoyaltyInfo = async () => {
        if (!id || !readProvider) return;

        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            readProvider
        );
        try {
            let [recipient, amount] = await nftContract.royaltyInfo(id, 10000);
            // console.log("Royalty info:", recipient, amount);
            amount = new Decimal(amount.toString());
            setRoyaltyInfo({
                recipient,
                amount: amount.div(100).toNumber(),
            });
        } catch (e) {
            // console.log(e);
            setStandardError(formatError(e));
        }
    };

    const queryTotalSupply = async () => {
        if (!id || !readProvider) return;

        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            readProvider
        );
        try {
            // ERC1155Supply tracks this on-chain. Reading it directly is one
            // call instead of scanning every mint event on the chain, and it
            // stays correct when a token is minted more than once or burned —
            // the previous event scan returned nothing in the first case and a
            // stale pre-burn figure in the second.
            setTotalSupply(await nftContract.totalSupply(id));
        } catch (e) {
            setStandardError(formatError(e));
        }
    };

    useEffect(() => {
        async function queryWalletAddress() {
            if (walletProvider) {
                try {
                    setWalletAddress(
                        await walletProvider.getSigner().getAddress()
                    );
                } catch (e) {
                    setStandardError(formatError(e));
                }
            }
        }
        queryWalletAddress();
    }, [walletProvider]);

    useEffect(() => {
        setStandardError(null);
    }, [id]);

    useEffect(() => {
        async function resetInfo() {
            setExists(true);
            setTokenData(null);
            setMetadataSource(null);
            setMetadataError(null);
            setMediaError(null);
            setTokenContent(null);
            setTokenType(null);
            setTokenAuthor(null);
            setRoyaltyInfo(null);
            setTotalSupply(null);
            setPrevValidId(null);
            setNextValidId(null);
            setListings(null);
            setListingSellerBalances({});
            setEvents(null);

            // Media is NOT chained onto the metadata here: it waits for the
            // policy decision in the effect below. The chain that used to run
            // it fired while `tokenAuthor` was still null, so a blocked
            // creator's media was downloaded before the entry could apply.
            queryTokenURI().then((tURI) => queryTokenData(tURI));
            setAuthorRead(false);
            queryTokenAuthor().then((author) => queryBalances(author));
            queryRoyaltyInfo();
            queryTotalSupply();

            const [prevId, nextId] = await Promise.all([
                queryPrevValidId(),
                queryNextValidId(),
            ]);
            setPrevValidId(prevId);
            setNextValidId(nextId);
        }
        resetInfo();
    }, [id, readProvider, reload]);

    // Both conditions, or neither: the metadata to fetch from, and a decision
    // that came back "show it". Keyed on the tri-state scalar rather than on
    // `policyStatus`, which is a fresh object every render.
    useEffect(() => {
        if (contentHidden === false) {
            queryTokenContent(tokenData);
        }
    }, [tokenData, contentHidden]);

    /*useEffect(() => queryTokenAuthor(), [id, readProvider])
    useEffect(() => queryRoyaltyInfo(), [id, readProvider])
    useEffect(() => queryTotalSupply(), [id, readProvider])
    useEffect(() => setExists(true), [id, readProvider])*/
    useEffect(() => {
        setRouteKnown(true);
        queryLastNFTId();
    }, []);

    // === Listing info ===

    const [listingSellerBalances, setListingSellerBalances] = useState({});

    const activeListings = () => {
        return listings
            ? listings.filter((listing) => parseInt(listing.seller, 16) != 0)
            : null;
    };

    // A listing whose seller, token or creator is blocklisted is not offered
    // for sale here, on this page exactly as on the marketplace. The creator is
    // this page's own `authorOf` read, so whatever `contentHidden` suppresses
    // above is withdrawn from sale here too — hiding a token while still
    // selling it through a reseller would be the policy in name only. Applied
    // to the rendered groups rather than to `activeListings`, because the
    // balance arithmetic below must still count every unit a seller has listed.
    const offeredListings = () =>
        visibleListings(activeListings(), {
            nftType: macroNftType,
            tokenId: id,
            creator: tokenAuthor,
            // Handed over for the same reason `contentHidden` is a tri-state:
            // a failed read leaves the creator unknown, and offering the token
            // anyway would sell exactly what the media decision withheld.
            creatorKnown: authorRead,
        });

    const listingGroups = () => {
        if (!activeListings()) {
            return null;
        }
        const groups = {};

        for (const listing of offeredListings().shown) {
            const seller = listing.seller;
            if (!groups[seller]) {
                groups[seller] = [];
            }
            groups[seller].push(listing);
        }

        const newGroups = [];

        for (const [seller, _listings] of Object.entries(groups)) {
            _listings.sort((a, b) => a.price - b.price);

            newGroups.push({
                seller,
                listings: _listings,
                sellerBalance: listingSellerBalances[seller], // undefined means that it's not available yet
            });
        }

        // Sort by price
        for (const group of newGroups) {
            group.listings.sort((a, b) => a.price - b.price);
        }
        newGroups.sort((a, b) => a.listings[0].price - b.listings[0].price);

        return newGroups;
    };

    const addressBalance = (address) => {
        return listingSellerBalances[address];
    };

    const userBalance = () => {
        return addressBalance(walletAddress);
    };

    const addressAvailableAmount = (address) => {
        if (!id || !walletAddress || activeListings() === null) return null;

        let _availableAmount = addressBalance(address);

        if (_availableAmount === null || _availableAmount === undefined) {
            return null;
        }

        for (const listing of activeListings()) {
            if (listing.seller == address) {
                _availableAmount -= listing.amount;
            }
        }

        if (_availableAmount < 0) {
            _availableAmount = 0;
        }

        return _availableAmount;
    };

    const userAvailableAmount = () => {
        return addressAvailableAmount(walletAddress);
    };

    const queryListings = async () => {
        if (!id || !readProvider) return;

        const contract = new ethers.Contract(
            marketplaceAddress,
            marketplaceABI,
            readProvider
        );

        try {
            // console.log("Querying listing count for", nftAddress, id);
            const listingCount = (
                await contract.listingCount(nftAddress, id)
            ).toNumber();
            // console.log("Listing count:", listingCount);

            const newListings = [];
            const promises = [];

            for (let i = 0; i < listingCount; i++) {
                promises.push(
                    contract
                        .listings(nftAddress, id, i)
                        .then((listing) =>
                            newListings.push({
                                amount: listing.amount.toNumber(),
                                price: formatTokenAmount(
                                    listing.price,
                                    tokenAddressToId[listing.paymentToken]
                                ),
                                paymentToken: listing.paymentToken,
                                seller: listing.seller,
                                id: i,
                            })
                        )
                        .catch((e) => console.log(e))
                );
            }

            await Promise.all(promises);

            newListings.sort((a, b) => a.price - b.price);

            // If a listing has seller 0x0000... it has been delisted
            setListings(newListings);
        } catch (e) {
            setStandardError(formatError(e));
        }
    };

    const updateSellerBalance = async (sellerAddress) => {
        if (!sellerAddress || !readProvider || !id) return;

        const nftContract = new ethers.Contract(
            nftAddress,
            nftABI,
            readProvider
        );
        try {
            const balance = await nftContract.balanceOf(sellerAddress, id);
            setListingSellerBalances((currentBalance) => ({
                ...currentBalance,
                [sellerAddress]: balance.toNumber(),
            }));
        } catch (e) {
            setStandardError(formatError(e));
        }
    };

    const queryUserBalance = async () => {
        await updateSellerBalance(walletAddress);
    };

    const queryListingSellerBalances = async () => {
        if (!id || !listings) return;

        const promises = [];

        try {
            // console.log("Querying seller balances...");
            if (activeListings()) {
                // console.log("Active listings:", activeListings());
                for (const sellerAddress of [
                    ...new Set(
                        activeListings().map((listing) => listing.seller)
                    ),
                ]) {
                    const promise = updateSellerBalance(sellerAddress);
                    promises.push(promise);
                }
            }

            await Promise.all(promises);
        } catch (e) {
            setStandardError(formatError(e));
        }
    };

    useEffect(() => {
        queryListings();
        queryTotalSupply();
        queryRoyaltyInfo();
        queryTokenAuthor().then((author) => queryBalances(author));
    }, [updateTracker, id, walletProvider]);

    useEffect(() => {
        queryUserBalance();
    }, [updateTracker, walletAddress, id]);

    useEffect(() => {
        queryListingSellerBalances();
    }, [listings]);

    async function queryTokenAllowances() {
        if (!walletAddress || !readProvider) return;
        getTokenAllowances(walletAddress, readProvider).then((allowances) =>
            setTokenAllowances(allowances)
        );
    }

    useEffect(() => {
        queryTokenAllowances();
    }, [id, walletAddress, updateTracker]);

    const onUpdate = (updatedNFTId) => {
        setUpdateTracker(([_, counter]) => [updatedNFTId, counter + 1]);
    };

    // parseHistory already runs for the History tab; the mint row inside it is
    // the transaction this token came into existence in, so provenance costs no
    // extra read. Undefined until the event scan resolves.
    const historyRows = parseHistory(events);
    const mintRow = historyRows?.find((row) => row.type === "mint") ?? null;

    // Derived only from validated route parameters, never from token metadata.
    const social = socialPreview(parsedQuery);
    const safeSocialId = social.url === "/nft" ? null : id;
    const socialTitle = social.title;
    const socialDescription = social.description;
    const socialUrl = social.url;
    const imageAltText =
        tokenData?.name && safeSocialId
            ? `${tokenData.name} image NFT #${safeSocialId}`
            : safeSocialId
            ? `Image NFT #${safeSocialId}`
            : "VinuNFT image";

    return (
        <div>
            <Helmet>
                <title>{socialTitle}</title>
                <meta name="description" content={socialDescription} />
                <meta property="og:title" content={socialTitle} />
                <meta property="og:description" content={socialDescription} />
                <meta property="og:type" content="website" />
                <meta property="og:url" content={socialUrl} />
                <meta name="twitter:card" content="summary" />
                <meta name="twitter:title" content={socialTitle} />
                <meta name="twitter:description" content={socialDescription} />
            </Helmet>
            <Header />
            <StandardErrorDisplay />
            {routeKnown && !(macroNftType && id) ? (
                /* Redirecting to the home page told the visitor nothing about
                   the link they followed. `marketplace` is a configured address
                   but not a collection, and "5abc" and "-1" are not tokens. */
                <div className="box m-4 nft-unsupported-route">
                    <h1 className="title is-5">This is not an NFT page</h1>
                    <p>
                        The address bar names no token this app can show. Only
                        the text and image collections are readable here, and
                        only at a whole, positive token id.
                    </p>
                </div>
            ) : exists ? (
                <div>
                    <div className="columns m-4">
                        <div
                            className="column is-two-thirds"
                            style={{ overflow: "hidden" }}
                        >
                            {readProvider ? (
                                <div>
                                    {policyStatus ? (
                                        <ContentNotice status={policyStatus} />
                                    ) : null}
                                    {contentHidden ? null : mediaError ? (
                                        <div className="box nft-media-unavailable">
                                            <p>{mediaError}</p>
                                            <button
                                                className="button is-small mt-2 nft-media-retry"
                                                onClick={() =>
                                                    setReload((n) => n + 1)
                                                }
                                            >
                                                Retry
                                            </button>
                                        </div>
                                    ) : routeKnown &&
                                      macroNftType === "image" ? (
                                        <img
                                            src={tokenContent}
                                            alt={imageAltText}
                                            style={{
                                                objectFit: "contain",
                                            }}
                                            className="imageNft"
                                        />
                                    ) : (
                                        <div className="box">
                                            {tokenType &&
                                            (tokenContent ||
                                                tokenContent == "") ? (
                                                tokenType == "text/html" ? (
                                                    <HTMLViewer
                                                        source={tokenContent}
                                                    />
                                                ) : tokenType ==
                                                  "text/markdown" ? (
                                                    <MarkdownViewer
                                                        source={tokenContent}
                                                    />
                                                ) : (
                                                    <pre className="nft-plain">
                                                        {tokenContent}
                                                    </pre>
                                                )
                                            ) : (
                                                <Skeleton count="12" />
                                            )}
                                        </div>
                                    )}
                                    {/* Restrictions the visitor cannot see are
                                        restrictions they cannot rely on: an
                                        in-content link that quietly does
                                        nothing reads as a broken page. */}
                                    <p className="is-size-7 nft-muted mt-2 nft-content-disclosure">
                                        This content was uploaded by its creator
                                        and is not reviewed or endorsed by
                                        VinuNFT. It renders in a sandboxed frame
                                        with scripts disabled, and links inside
                                        it are disabled: nothing here can
                                        navigate you anywhere.
                                    </p>
                                </div>
                            ) : (
                                <p>Connect a wallet to view this NFT</p>
                            )}
                        </div>
                        <div className="column">
                            <h1 className="title">
                                {contentHidden ? (
                                    "Hidden by content policy"
                                ) : metadataError ? (
                                    metadataError
                                ) : tokenData ? (
                                    tokenData.name || "Untitled"
                                ) : (
                                    <Skeleton />
                                )}
                            </h1>
                            <p className="subtitle mb-1">
                                {tokenAuthor !== null ? (
                                    <>
                                        by{" "}
                                        <Address
                                            address={tokenAuthor}
                                            shorten
                                            nChar={8}
                                        />
                                    </>
                                ) : (
                                    <Skeleton />
                                )}
                            </p>
                            <div className="has-text-left m-0">
                                {/* Supply is an on-chain read and stays true
                                    when the media fetch fails; gating it on the
                                    content type reported a figure the chain does
                                    not agree with. */}
                                <span>
                                    {tokenType ? (
                                        <TypeTag type={tokenType} />
                                    ) : mediaError ? (
                                        <></>
                                    ) : (
                                        <Skeleton inline width={90} />
                                    )}
                                    {totalSupply !== null ? (
                                        <span className="tag is-black ml-1">
                                            Edition size:{" "}
                                            {totalSupply.toString()}
                                        </span>
                                    ) : (
                                        <Skeleton
                                            className="ml-1"
                                            inline
                                            width={90}
                                        />
                                    )}
                                </span>
                            </div>
                            <p className="is-italic">
                                {contentHidden ? (
                                    ""
                                ) : metadataError ? (
                                    metadataError
                                ) : tokenData ? (
                                    tokenData.description ?? ""
                                ) : (
                                    <Skeleton />
                                )}
                            </p>

                            {royaltyInfo &&
                            tokenAuthor &&
                            royaltyInfo?.amount !== null ? (
                                <p className="is-size-6 mt-5">
                                    {royaltyInfo.amount.toFixed(2)}% of every
                                    secondary sale goes to{" "}
                                    {royaltyInfo.recipient == tokenAuthor
                                        ? "the author"
                                        : royaltyInfo.recipient}
                                    .
                                </p>
                            ) : (
                                <Skeleton />
                            )}
                            <hr />
                            {/* Provenance: which contract, which token, where
                                the metadata physically lives, and the mint that
                                created it. Nothing here is taken from metadata
                                except the source label, which names its own
                                origin. */}
                            {routeKnown ? (
                                <dl className="nft-provenance is-size-7">
                                    <dt className="has-text-weight-semibold">
                                        Contract
                                    </dt>
                                    <dd className="mb-2">
                                        <Address
                                            address={nftAddress}
                                            external
                                            shorten
                                            nChar={8}
                                        />
                                    </dd>
                                    <dt className="has-text-weight-semibold">
                                        Token ID
                                    </dt>
                                    <dd className="mb-2">{id}</dd>
                                    <dt className="has-text-weight-semibold">
                                        Metadata
                                    </dt>
                                    <dd className="mb-2">
                                        {metadataError ? (
                                            "Unavailable"
                                        ) : metadataSource ? (
                                            metadataSource.source ===
                                            "on-chain" ? (
                                                "On-chain (data: URI stored in the contract)"
                                            ) : (
                                                <>
                                                    External:{" "}
                                                    <code>
                                                        {metadataSource.uri.slice(
                                                            0,
                                                            80
                                                        )}
                                                    </code>
                                                </>
                                            )
                                        ) : (
                                            <Skeleton width={160} />
                                        )}
                                    </dd>
                                    <dt className="has-text-weight-semibold">
                                        Minted in
                                    </dt>
                                    <dd className="mb-2">
                                        {historyRows === undefined ? (
                                            <Skeleton width={160} />
                                        ) : mintRow ? (
                                            <a
                                                target="_blank"
                                                rel="noreferrer"
                                                style={{
                                                    textDecoration: "underline",
                                                }}
                                                href={
                                                    config.blockExplorer.url +
                                                    "/tx/" +
                                                    mintRow.transactionHash
                                                }
                                            >
                                                block {mintRow.blockNumber}
                                            </a>
                                        ) : (
                                            "No mint event found in the scanned range"
                                        )}
                                    </dd>
                                </dl>
                            ) : (
                                <Skeleton count={4} />
                            )}
                            <p className="is-size-7 nft-muted">
                                Contract, token ID, edition size, creator,
                                royalty, listings, owners and history are read
                                from VinuChain. Name, description and media come
                                from the metadata source named above.
                            </p>
                            <p className="is-size-7 nft-muted nft-identity-disclaimer">
                                The creator address is not identity-verified. It
                                proves control of a key and nothing more: the
                                name, description and media are whatever the
                                minter chose, and may impersonate a person,
                                brand or collection. Only the three contracts
                                listed above are ever read by this app.{" "}
                                <a
                                    target="_blank"
                                    rel="noreferrer nofollow"
                                    href={REPORT_URL}
                                >
                                    Report this content
                                </a>
                                .
                            </p>
                            <hr />
                            {offeredListings().hiddenByPolicy > 0 ? (
                                <p className="is-size-7 nft-muted">
                                    {offeredListings().hiddenByPolicy}{" "}
                                    listing(s) are not offered here under the
                                    content policy. They still exist on chain
                                    and can still be bought or delisted through
                                    any other client — including by a seller
                                    whose own row this page has withdrawn.
                                </p>
                            ) : null}
                            {/* Only once the read has FAILED. `authorRead`
                            is also false while it is still in flight, and
                            "could not be read" is not true of a read that has
                            not finished. */}
                            {mediaError === CREATOR_UNCHECKED &&
                            offeredListings().withheldUnknownCreator > 0 ? (
                                <p className="is-size-7 nft-muted">
                                    {offeredListings().withheldUnknownCreator}{" "}
                                    listing(s) are held back because this
                                    token&apos;s creator could not be read, so
                                    the content policy could not be applied.
                                    Retrying the media read above re-runs it.
                                </p>
                            ) : null}
                            <Listings
                                nftType={macroNftType}
                                readProvider={readProvider}
                                walletProvider={walletProvider}
                                id={id}
                                walletAddress={walletAddress}
                                onUpdate={onUpdate}
                                userBalance={userBalance()}
                                userAvailableAmount={userAvailableAmount()}
                                listingGroups={listingGroups()}
                            />

                            <hr />
                            {readProvider && walletProvider ? (
                                <div>
                                    {userBalance() !== null ? (
                                        userBalance() != 0 ? (
                                            <div>
                                                <p>Owned: {userBalance()}</p>
                                                {userAvailableAmount() ===
                                                null ? (
                                                    <Skeleton />
                                                ) : (
                                                    <p>
                                                        Not listed:{" "}
                                                        {userAvailableAmount()}
                                                    </p>
                                                )}
                                                <div className="is-flex is-justify-content-center">
                                                    <TransferButton
                                                        nftType={macroNftType}
                                                        id={id}
                                                        walletAddress={
                                                            walletAddress
                                                        }
                                                        balance={userBalance()}
                                                        availableAmount={userAvailableAmount()}
                                                        onUpdate={onUpdate}
                                                    />
                                                    <BurnButton
                                                        nftType={macroNftType}
                                                        id={id}
                                                        walletAddress={
                                                            walletAddress
                                                        }
                                                        balance={userBalance()}
                                                        availableAmount={userAvailableAmount()}
                                                        onUpdate={onUpdate}
                                                    />
                                                </div>
                                            </div>
                                        ) : (
                                            <></>
                                        )
                                    ) : (
                                        <Skeleton height={3} />
                                    )}
                                </div>
                            ) : (
                                <></>
                            )}
                            {readProvider ? (
                                <>
                                    <div className="tabs is-centered is-fullwidth">
                                        {/* The anchors carry no href, so they
                                            were unreachable by Tab and deaf to
                                            Enter: the two tabs were the only
                                            pointer-only controls on the page.
                                            Kept as anchors so Bulma's own
                                            `.tabs li a` geometry still applies. */}
                                        <ul role="tablist">
                                            <li
                                                className={
                                                    isOwners
                                                        ? "is-active has-text-weight-semibold"
                                                        : ""
                                                }
                                            >
                                                <a
                                                    role="tab"
                                                    tabIndex={0}
                                                    aria-selected={isOwners}
                                                    onClick={setOwners}
                                                    onKeyDown={(event) =>
                                                        activateOnKey(
                                                            event,
                                                            setOwners
                                                        )
                                                    }
                                                >
                                                    Owners
                                                </a>
                                            </li>
                                            <li
                                                className={
                                                    isOwners
                                                        ? ""
                                                        : "is-active has-text-weight-semibold"
                                                }
                                            >
                                                <a
                                                    role="tab"
                                                    tabIndex={0}
                                                    aria-selected={!isOwners}
                                                    onClick={setHistory}
                                                    onKeyDown={(event) =>
                                                        activateOnKey(
                                                            event,
                                                            setHistory
                                                        )
                                                    }
                                                >
                                                    History
                                                </a>
                                            </li>
                                        </ul>
                                    </div>
                                    <div>
                                        {isOwners ? (
                                            <NFTOwners
                                                balances={computeBalances(
                                                    events
                                                )}
                                            />
                                        ) : (
                                            <div
                                                style={{
                                                    maxHeight: "25em",
                                                    overflowY: "auto",
                                                }}
                                            >
                                                <NFTHistory
                                                    history={historyRows}
                                                    hideId
                                                />
                                            </div>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <></>
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <p>This NFT doesn't exist.</p>
            )}
        </div>
    );
}
