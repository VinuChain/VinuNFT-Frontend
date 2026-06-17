import React, { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTransactionStatus } from "./common/transaction_status";
import { ToastContainer, toast } from "react-toastify";
import TransactionNotifications from "./components/TransactionNotifications";

const VINUCHAIN_SOCIAL_LINKS = [
    {
        label: "GitHub",
        shortLabel: "GH",
        href: "https://github.com/VinuChain",
    },
    {
        label: "X",
        shortLabel: "X",
        href: "https://twitter.com/vinuchain",
    },
    {
        label: "Discord",
        shortLabel: "DC",
        href: "https://discord.gg/vinu",
    },
    {
        label: "Telegram",
        shortLabel: "TG",
        href: "https://t.me/vitainu",
    },
    {
        label: "Medium",
        shortLabel: "MD",
        href: "https://medium.com/vinuchain",
    },
];

const FOOTER_LINKS = [
    {
        label: "Contact",
        href: "mailto:hello@vitainu.org",
        external: false,
    },
    {
        label: "VinuExplorer",
        href: "https://mainnet.vinuexplorer.org",
        external: true,
    },
    {
        label: "VinuChain",
        href: "https://vinuchain.org",
        external: true,
    },
];

export default function Wrapper({ children, props }) {
    const [visibility, setVisibility] = useState("hidden");

    useEffect(() => {
        setVisibility("visible");
    }, []);

    return (
        <div>
            <Helmet>
                <meta charSet="utf-8" />
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1"
                />
                <meta name="icon" href="/public/favicon.ico" />
                <meta
                    name="description"
                    content="NFTs by VinuNFT, Vita Inu's premier NFT platform."
                />
                <meta name="keywords" content="vinu, text, NFTs, on-chain" />
            </Helmet>
            {process.env.NODE_ENV !== "development" ? (
                <Helmet>
                    {/* CSP seed: add_csp.js replaces the script-src value at
                        build time with the full expanded policy (default-src,
                        object-src, base-uri, frame-ancestors, img-src,
                        style-src, frame-src, connect-src) plus sha256 hashes
                        for every inline script. Keep this value as the exact
                        template string that add_csp.js targets. */}
                    <meta
                        httpEquiv="Content-Security-Policy"
                        content="script-src 'self'"
                    />
                </Helmet>
            ) : (
                <></>
            )}
            <div style={{ visibility: visibility }}>
                <div style={{ minHeight: "90vh" }}>{children}</div>
                <TransactionNotifications />
                <footer className="vinunft-footer">
                    <div className="vinunft-footer__inner">
                        <div className="vinunft-footer__content">
                            <div className="vinunft-footer__brand">
                                <img
                                    className="vinunft-footer__logo"
                                    src="/vinunft.png"
                                    alt=""
                                    aria-hidden="true"
                                />
                                <div>
                                    <p className="vinunft-footer__eyebrow">
                                        VinuNFT
                                    </p>
                                    <p className="vinunft-footer__copy">
                                        Collect text and image NFTs on VinuChain
                                        mainnet.
                                    </p>
                                </div>
                            </div>
                            <nav
                                className="vinunft-footer__links"
                                aria-label="VinuNFT links"
                            >
                                {FOOTER_LINKS.map((link) => (
                                    <a
                                        key={link.label}
                                        className="vinunft-footer__link"
                                        href={link.href}
                                        target={
                                            link.external ? "_blank" : undefined
                                        }
                                        rel="noreferrer"
                                    >
                                        {link.label}
                                    </a>
                                ))}
                            </nav>
                        </div>

                        <div className="vinunft-footer__social-block">
                            <p className="vinunft-footer__section-title">
                                VinuChain socials
                            </p>
                            <nav
                                className="vinunft-footer__socials"
                                aria-label="VinuChain social links"
                            >
                                {VINUCHAIN_SOCIAL_LINKS.map((link) => (
                                    <a
                                        key={link.label}
                                        className="vinunft-footer__social"
                                        href={link.href}
                                        target="_blank"
                                        rel="noreferrer"
                                        aria-label={`VinuChain ${link.label}`}
                                    >
                                        <span
                                            className="vinunft-footer__social-mark"
                                            aria-hidden="true"
                                        >
                                            {link.shortLabel}
                                        </span>
                                        <span>{link.label}</span>
                                    </a>
                                ))}
                            </nav>
                        </div>
                    </div>
                </footer>
            </div>
        </div>
    );
}
