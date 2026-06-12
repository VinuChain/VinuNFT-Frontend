import React, { useEffect, useState } from "react";
import { RoutingLink, WalletButton } from ".";
import { useWalletProvider } from "../common/provider";
import config from "../config";

const NAV_LINKS = [
    {
        href: "/",
        label: "Home",
    },
    {
        href: "/mint",
        label: "Mint",
    },
    {
        href: "/marketplace",
        label: "Marketplace",
    },
    {
        href: "/bridge",
        label: "Bridge",
    },
    {
        href: "/activity",
        label: "Activity",
    },
];

export default function Header() {
    const [isActive, setActive] = useState(false);
    const [walletProvider] = useWalletProvider();
    const [chainId, setChainId] = useState(null);

    async function walletProviderChanged() {
        if (!walletProvider) {
            return;
        }

        const network = await walletProvider.getNetwork();
        const newChainId = network.chainId;

        if (chainId !== null && newChainId !== chainId) {
            // Chain ID changed. Following ethers.js recommendations, reload.
            window.location.reload();
        }

        setChainId(newChainId);
    }

    useEffect(() => {
        walletProviderChanged();
    }, [walletProvider]);

    function toggleClass() {
        setActive((current) => !current);
    }

    return (
        <header className="vinunft-header-shell">
            <nav
                className="navbar vinunft-header"
                role="navigation"
                aria-label="Main navigation"
            >
                <div className="vinunft-header__inner">
                    <div className="navbar-brand vinunft-header__brand">
                        <RoutingLink
                            className="navbar-item vinunft-header__home"
                            href="/"
                        >
                            <span className="vinunft-header__logo-frame">
                                <img
                                    className="vinunft-header__logo"
                                    src="/vinunft.png"
                                    alt=""
                                    aria-hidden="true"
                                />
                            </span>
                            <span className="vinunft-header__title-stack">
                                <span className="vinunft-header__title">
                                    VinuNFT
                                </span>
                                <span className="vinunft-header__subtitle">
                                    VinuChain mainnet
                                </span>
                            </span>
                        </RoutingLink>

                        <button
                            type="button"
                            className={
                                "navbar-burger vinunft-header__burger" +
                                (isActive ? " is-active" : "")
                            }
                            onClick={toggleClass}
                            aria-label="Toggle navigation"
                            aria-expanded={isActive}
                            aria-controls="vinunft-navbar"
                            data-target="vinunft-navbar"
                        >
                            <span aria-hidden="true"></span>
                            <span aria-hidden="true"></span>
                            <span aria-hidden="true"></span>
                        </button>
                    </div>

                    <div
                        id="vinunft-navbar"
                        className={
                            "navbar-menu vinunft-header__menu" +
                            (isActive ? " is-active" : "")
                        }
                    >
                        <div className="navbar-start vinunft-header__nav">
                            {NAV_LINKS.map((link) => (
                                <RoutingLink
                                    key={link.href}
                                    href={link.href}
                                    className="navbar-item vinunft-header__nav-link"
                                >
                                    {link.label}
                                </RoutingLink>
                            ))}

                            {walletProvider ? (
                                <RoutingLink
                                    href="/vault"
                                    className="navbar-item vinunft-header__nav-link"
                                >
                                    Vault
                                </RoutingLink>
                            ) : null}
                        </div>

                        <div className="navbar-end vinunft-header__actions">
                            <div className="navbar-item vinunft-header__wallet">
                                <WalletButton />
                            </div>
                        </div>
                    </div>
                </div>
            </nav>
            {chainId !== null && chainId !== config.networks.main.chainId ? (
                <div className="notification is-danger vinunft-header__network-alert">
                    <p>
                        Error: please switch to{" "}
                        <strong>{config.networks.main.name}</strong>.
                    </p>
                </div>
            ) : null}
        </header>
    );
}
