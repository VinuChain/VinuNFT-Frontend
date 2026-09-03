import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Helmet } from "react-helmet";
import { Header, NFTCard } from "../components";
import Address from "../components/Address";
import {
    loadAddressProfileNfts,
    profileSection,
    PROFILE_PAGE_SIZE,
} from "../common/addressProfile";
import { useReadProvider } from "../common/provider";
import config from "../config";

import "bulma/css/bulma.min.css";
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../styles/globals.css";
import { coverageSentence } from "../common/utils";

// Every relationship the index can express for one address. Rendered from one
// list because five hand-written sections differ only in a heading.
const SECTIONS = [
    ["owned", "Owned NFTs"],
    ["created", "Created NFTs"],
    ["listed", "Listed for sale"],
    ["bought", "Bought"],
    ["sold", "Sold"],
];

const EMPTY_PROFILE = {
    owned: [],
    created: [],
    listed: [],
    bought: [],
    sold: [],
};

/** What the profile covers, stated rather than implied. */
function coverageLine(profile) {
    return coverageSentence(
        "every edition, listing and sale",
        profile.indexedThrough ?? null,
        profile.lag?.blocks
    );
}

/**
 * One section's cards, bounded, with what is not shown stated rather than
 * quietly cut off.
 */
function SectionCards({ section, refs, shown, onShowMore }) {
    const { rows, remaining } = profileSection(refs, shown);
    return (
        <>
            <div className="address-profile__grid">
                {rows.map((nft) => (
                    <NFTCard
                        key={`${nft.type}-${nft.id}`}
                        type={nft.type}
                        id={nft.id}
                    />
                ))}
            </div>
            {remaining > 0 ? (
                <button
                    type="button"
                    className="button is-light mt-3"
                    onClick={onShowMore}
                >
                    Show {remaining} more in {section}
                </button>
            ) : null}
        </>
    );
}

export default function AddressPage({ location }) {
    const [readProvider] = useReadProvider();
    const query = useMemo(
        () => new URLSearchParams(location.search),
        [location.search]
    );
    const rawAddress = query.get("address") || "";
    const isValidAddress = ethers.utils.isAddress(rawAddress);
    const normalizedAddress = isValidAddress
        ? ethers.utils.getAddress(rawAddress)
        : null;

    const [profile, setProfile] = useState(EMPTY_PROFILE);
    // How many cards each section is currently showing. Every card reads its
    // own URI and author, so a section that renders a whole profile at once is
    // hundreds of simultaneous RPC and gateway requests.
    const [shown, setShown] = useState({});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;

        async function loadProfile() {
            if (!readProvider || !normalizedAddress) {
                return;
            }

            setLoading(true);
            setError(null);
            setShown({});
            try {
                const nextProfile = await loadAddressProfileNfts(
                    readProvider,
                    normalizedAddress
                );
                if (!cancelled) {
                    setProfile(nextProfile);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e.message || "Could not load address profile.");
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        loadProfile();
        return () => {
            cancelled = true;
        };
    }, [readProvider, normalizedAddress]);

    return (
        <div>
            <Helmet>
                <title>Address - VinuNFT</title>
            </Helmet>
            <Header />
            <main className="vinunft-page">
                {!isValidAddress ? (
                    <p className="notification is-danger">
                        Invalid address. Open a profile with{" "}
                        <code>/address?address=0x...</code>.
                    </p>
                ) : (
                    <>
                        <section className="vinunft-page__header">
                            <p className="vinunft-page__eyebrow">
                                {error
                                    ? "Index scan failed - profile coverage is unknown"
                                    : coverageLine(profile)}
                            </p>
                            <h1 className="title">Address Profile</h1>
                            <p className="address-profile__address">
                                <Address
                                    address={normalizedAddress}
                                    shorten
                                    nChar={10}
                                    disableLink
                                />
                            </p>
                            <a
                                className="button is-light"
                                href={`${config.blockExplorer.url}/address/${normalizedAddress}`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View on {config.blockExplorer.name}
                            </a>
                        </section>

                        {error ? (
                            <p className="notification is-danger">{error}</p>
                        ) : loading ? (
                            <p>Loading indexed address profile...</p>
                        ) : (
                            <>
                                {SECTIONS.map(([key, heading]) => (
                                    <section
                                        className="address-profile__section"
                                        key={key}
                                    >
                                        <h2 className="title is-4">
                                            {heading}
                                        </h2>
                                        {profile[key].length === 0 ? (
                                            <p>None in the index.</p>
                                        ) : (
                                            <SectionCards
                                                section={heading}
                                                refs={profile[key]}
                                                shown={shown[key]}
                                                onShowMore={() =>
                                                    setShown((current) => ({
                                                        ...current,
                                                        [key]:
                                                            (current[key] ??
                                                                PROFILE_PAGE_SIZE) +
                                                            PROFILE_PAGE_SIZE,
                                                    }))
                                                }
                                            />
                                        )}
                                    </section>
                                ))}
                            </>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
