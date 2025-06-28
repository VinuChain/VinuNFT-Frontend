import React, { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTransactionStatus } from "./common/transaction_status";
import { ToastContainer, toast } from "react-toastify";
import TransactionNotifications from "./components/TransactionNotifications";

export default function Wrapper({ children, props }) {
    const [visibility, setVisibility] = useState("hidden");

    useEffect(() => {
        setVisibility("visible");
    }, []);

    return (
        <div>
            <Helmet>
                <meta charSet="utf-8" />
                <meta name="icon" href="/public/favicon.ico" />
                <meta
                    name="description"
                    content="NFTs by VinuNFT, Vita Inu's premier NFT platform."
                />
                <meta name="keywords" content="vinu, text, NFTs, on-chain" />
            </Helmet>
            {process.env.NODE_ENV !== "development" ? (
                <Helmet>
                    <meta
                        http-equiv="Content-Security-Policy"
                        content="script-src 'self'"
                    />
                </Helmet>
            ) : (
                <></>
            )}
            <div style={{ visibility: visibility }}>
                <div style={{ minHeight: "90vh" }}>{children}</div>
                <TransactionNotifications />
                <footer className="footer has-background-black has-text-white">
                    <div className="columns">
                        <div className="column has-text-centered">
                            <p>
                                <a href="mailto:hello@vitainu.org">
                                    <u>hello@vitainu.org</u>
                                </a>
                                <br />
                                <a
                                    href="https://github.com/Vita-Inu"
                                    target="_blank"
                                >
                                    <u>github.com/Vita-Inu</u>
                                </a>
                                <br />
                                <a
                                    href="https://x.com/vinuchain"
                                    target="_blank"
                                >
                                    <u>x.com/vinuchain</u>
                                </a>
                            </p>
                        </div>
                    </div>
                </footer>
            </div>
        </div>
    );
}
