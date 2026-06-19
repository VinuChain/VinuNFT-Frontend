import React, { useState } from "react";
import { Helmet } from "react-helmet";
import { Header } from "../components";
import {
    fileNameFromHref,
    mediaAssets,
    mediaGroups,
} from "../common/mediaAssets";

import "bulma/css/bulma.min.css";
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../styles/globals.css";

function AssetCard({ asset, origin }) {
    const [copied, setCopied] = useState(false);
    const fullUrl = origin ? `${origin}${asset.href}` : asset.href;
    const titleId = `${asset.id}-title`;

    async function copy() {
        try {
            await navigator.clipboard.writeText(fullUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
        } catch {
            // Clipboard writes can be blocked by browser permissions.
        }
    }

    return (
        <article className="media-kit-card">
            <div
                className={`media-kit-card__preview media-kit-card__preview--${asset.preview}`}
            >
                <img
                    src={asset.previewSrc || asset.href}
                    alt={asset.title}
                    loading="lazy"
                />
            </div>
            <h3 className="media-kit-card__title" id={titleId}>
                {asset.title}
            </h3>
            <div className="media-kit-card__pills">
                <span>{asset.format}</span>
                <span>{asset.dimensions}</span>
            </div>
            <p className="media-kit-card__description">{asset.description}</p>
            <div className="media-kit-card__actions">
                <input
                    readOnly
                    aria-labelledby={titleId}
                    value={fullUrl}
                    onClick={(event) => event.currentTarget.select()}
                />
                <button type="button" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <a
                className="media-kit-card__download"
                href={asset.href}
                download={fileNameFromHref(asset.href)}
            >
                Download
            </a>
        </article>
    );
}

export default function Media() {
    const origin =
        typeof window !== "undefined" && window.location
            ? window.location.origin
            : "";

    return (
        <div>
            <Helmet>
                <title>Media Kit - VinuNFT</title>
                <meta
                    name="description"
                    content="Official VinuNFT brand marks and direct media asset downloads."
                />
            </Helmet>
            <Header />
            <main className="media-kit-page">
                <section className="media-kit-hero">
                    <p className="media-kit-hero__eyebrow">Brand & Media Kit</p>
                    <h1>Media Assets</h1>
                    <p>
                        Official VinuNFT marks for marketplace pages, ecosystem
                        announcements, partner directories, and social posts.
                        Copy a direct URL or download the original file.
                    </p>
                </section>

                <div className="media-kit-sections">
                    {mediaGroups.map((group) => {
                        const items = mediaAssets.filter(
                            (asset) => asset.group === group.id
                        );
                        if (items.length === 0) {
                            return null;
                        }

                        return (
                            <section
                                className="media-kit-section"
                                key={group.id}
                            >
                                <div className="media-kit-section__header">
                                    <h2>{group.label}</h2>
                                    <p>{group.blurb}</p>
                                </div>
                                <div className="media-kit-grid">
                                    {items.map((asset) => (
                                        <AssetCard
                                            asset={asset}
                                            key={asset.id}
                                            origin={origin}
                                        />
                                    ))}
                                </div>
                            </section>
                        );
                    })}
                </div>
            </main>
        </div>
    );
}
