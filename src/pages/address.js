import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Helmet } from "react-helmet";
import { Header, NFTCard } from "../components";
import Address from "../components/Address";
import {
    ADDRESS_PROFILE_WINDOW,
    loadAddressProfileNfts,
} from "../common/addressProfile";
import { useReadProvider } from "../common/provider";
import config from "../config";

import "bulma/css/bulma.min.css";
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../styles/globals.css";

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

    const [profile, setProfile] = useState({ owned: [], created: [] });
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
                                Bounded profile window: latest{" "}
                                {ADDRESS_PROFILE_WINDOW} tokens per type
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
                            <p>Loading bounded address profile...</p>
                        ) : (
                            <>
                                <section className="address-profile__section">
                                    <h2 className="title is-4">Owned NFTs</h2>
                                    {profile.owned.length === 0 ? (
                                        <p>
                                            No owned NFTs found in the bounded
                                            profile window.
                                        </p>
                                    ) : (
                                        <div className="address-profile__grid">
                                            {profile.owned.map((nft) => (
                                                <NFTCard
                                                    key={`${nft.type}-${nft.id}`}
                                                    type={nft.type}
                                                    id={nft.id}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </section>

                                <section className="address-profile__section">
                                    <h2 className="title is-4">Created NFTs</h2>
                                    {profile.created.length === 0 ? (
                                        <p>
                                            No created NFTs found in the bounded
                                            profile window.
                                        </p>
                                    ) : (
                                        <div className="address-profile__grid">
                                            {profile.created.map((nft) => (
                                                <NFTCard
                                                    key={`${nft.type}-${nft.id}`}
                                                    type={nft.type}
                                                    id={nft.id}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </section>
                            </>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
