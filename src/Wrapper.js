import React, { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTransactionStatus } from "./common/transaction_status";
import { ToastContainer, toast } from "react-toastify";
import TransactionNotifications from "./components/TransactionNotifications";
// Imported here so every page gets it: 404 and activity did not import it
// individually, so global rules silently did not apply there.
import "./styles/globals.css";
import config from "./config";
import { CONTENT_POLICY_URL, REPORT_URL } from "./common/contentPolicy";

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
        // The public issue tracker is the intake queue AND the audit trail: a
        // report, the evidence, the decision and the blocklist pull request all
        // sit on one thread that neither side can quietly edit away. The mailto
        // above stays as the private route for legal correspondence.
        label: "Report content",
        href: REPORT_URL,
        external: true,
    },
    {
        // docs/ is not copied into public/, so this must be the repository blob.
        label: "Content policy",
        href: CONTENT_POLICY_URL,
        external: true,
    },
    {
        // From the one registry, so the footer cannot drift from the explorer
        // links the rest of the app builds.
        label: config.blockExplorer.name,
        href: config.blockExplorer.url,
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
