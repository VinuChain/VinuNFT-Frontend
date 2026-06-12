import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Helmet } from "react-helmet";
import { Header, WalletButton } from "../components";
import { useWalletProvider } from "../common/provider";
import {
    feeLabel,
    formatRawTokenAmount,
    getBridgeEvmChain,
    isAmountWithinQuota,
    isEvmBridgeChain,
    isPositiveDecimalAmount,
    nativeFeeDecimalsForChain,
    nativeFeeSymbolForChain,
    priorityRank,
    quotaIsUnavailable,
    tokenKey,
    toHexChainId,
    WANBRIDGE_WEB_URL,
} from "../common/wanbridge";
import { isDestinationAccount } from "../common/wanbridgeValidation";

import "bulma/css/bulma.min.css";
import "bulma-extensions/dist/css/bulma-extensions.min.css";
import "../styles/globals.css";

const APPROVE_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
];

const FEATURED_SYMBOLS = ["USDT", "VINU", "VC"];

function responseHasMessage(value) {
    return Boolean(value && typeof value.message === "string");
}

function getErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return "Unexpected bridge error";
}

function isWalletAddChainError(error) {
    return (
        error?.code === 4902 ||
        (typeof error?.message === "string" &&
            /unrecognized|not added|unknown chain/i.test(error.message))
    );
}

async function switchToBridgeChain(walletProvider, chain) {
    const provider = walletProvider?.provider;
    if (!provider?.request) {
        throw new Error("Wallet provider does not expose request.");
    }

    const chainId = toHexChainId(chain.chainId);
    try {
        await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId }],
        });
    } catch (error) {
        if (!isWalletAddChainError(error)) {
            throw error;
        }

        await provider.request({
            method: "wallet_addEthereumChain",
            params: [
                {
                    chainId,
                    chainName: chain.name,
                    nativeCurrency: {
                        name: chain.currency,
                        symbol: chain.currency,
                        decimals: 18,
                    },
                    rpcUrls: [chain.rpcUrl],
                    blockExplorerUrls: [chain.explorerUrl],
                },
            ],
        });
    }
}

function buildTokenOptions(routes, direction) {
    const options = new Map();
    for (const route of routes) {
        if (route.direction !== direction) {
            continue;
        }

        const key = tokenKey(route.vcToken);
        const current = options.get(key);
        if (current) {
            current.routeCount += 1;
            continue;
        }

        options.set(key, {
            key,
            symbol: route.vcToken.symbol,
            name: route.vcToken.name,
            routeCount: 1,
            priorityRank: priorityRank(route.vcToken.symbol),
        });
    }

    return [...options.values()].sort((left, right) => {
        if (left.priorityRank !== right.priorityRank) {
            return left.priorityRank - right.priorityRank;
        }

        return left.symbol.localeCompare(right.symbol);
    });
}

function sortRoutes(routes) {
    return [...routes].sort((left, right) => {
        if (left.supportsInAppSigning !== right.supportsInAppSigning) {
            return left.supportsInAppSigning ? -1 : 1;
        }

        const leftBnb = left.remoteChain.chainType === "BNB" ? 0 : 1;
        const rightBnb = right.remoteChain.chainType === "BNB" ? 0 : 1;
        if (leftBnb !== rightBnb) {
            return leftBnb - rightBnb;
        }

        return left.remoteChain.chainName.localeCompare(
            right.remoteChain.chainName
        );
    });
}

function routeDescription(route) {
    if (!route) {
        return "Loading live WanBridge routes.";
    }
    if (!route.supportsInAppSigning) {
        return `${route.fromChain.chainName} source wallets continue in the official WanBridge app.`;
    }
    return `This signs on ${route.fromChain.chainName} and delivers ${route.toToken.symbol} on ${route.toChain.chainName}.`;
}

function validateDestination(route, value) {
    if (!route) {
        return false;
    }

    return isDestinationAccount(value.trim(), route.toChain.chainType);
}

export default function Bridge({ location }) {
    const query = useMemo(
        () => new URLSearchParams(location.search),
        [location.search]
    );
    const queryToken = (query.get("token") || "").trim().toUpperCase();
    const queryDirection =
        query.get("direction") === "out" || query.get("direction") === "into"
            ? query.get("direction")
            : "into";

    const [walletProvider] = useWalletProvider();
    const [walletAddress, setWalletAddress] = useState(null);
    const [catalog, setCatalog] = useState(null);
    const [catalogError, setCatalogError] = useState(null);
    const [direction, setDirection] = useState(queryDirection);
    const [selectedTokenKey, setSelectedTokenKey] = useState("");
    const [selectedRouteId, setSelectedRouteId] = useState("");
    const [amount, setAmount] = useState("");
    const [destination, setDestination] = useState("");
    const [quota, setQuota] = useState(null);
    const [quotaLoading, setQuotaLoading] = useState(false);
    const [quotaError, setQuotaError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [actionMessage, setActionMessage] = useState(null);
    const [lastTx, setLastTx] = useState(null);
    const [lastHash, setLastHash] = useState(null);

    useEffect(() => {
        let cancelled = false;

        async function loadWalletAddress() {
            if (!walletProvider) {
                setWalletAddress(null);
                return;
            }

            try {
                const address = await walletProvider.getSigner().getAddress();
                if (!cancelled) {
                    setWalletAddress(address);
                }
            } catch (e) {
                if (!cancelled) {
                    setWalletAddress(null);
                }
            }
        }

        loadWalletAddress();
        return () => {
            cancelled = true;
        };
    }, [walletProvider]);

    useEffect(() => {
        const controller = new AbortController();

        async function loadCatalog() {
            try {
                setCatalogError(null);
                const response = await fetch("/api/wanbridge-token-pairs", {
                    signal: controller.signal,
                });
                const payload = await response.json();
                if (!response.ok || responseHasMessage(payload)) {
                    throw new Error(
                        responseHasMessage(payload)
                            ? payload.message
                            : "Could not load routes"
                    );
                }
                setCatalog(payload);
            } catch (error) {
                if (!controller.signal.aborted) {
                    setCatalogError(getErrorMessage(error));
                }
            }
        }

        loadCatalog();
        return () => controller.abort();
    }, []);

    const routes = catalog?.routes || [];
    const tokenOptions = useMemo(
        () => buildTokenOptions(routes, direction),
        [routes, direction]
    );
    const selectedToken = tokenOptions.find(
        (option) => option.key === selectedTokenKey
    );
    const tokenRoutes = useMemo(
        () =>
            sortRoutes(
                routes.filter(
                    (route) =>
                        route.direction === direction &&
                        tokenKey(route.vcToken) === selectedTokenKey
                )
            ),
        [routes, direction, selectedTokenKey]
    );
    const selectedRoute =
        tokenRoutes.find((route) => route.id === selectedRouteId) ||
        tokenRoutes[0] ||
        null;
    const featuredRoutes = useMemo(
        () =>
            FEATURED_SYMBOLS.map((symbol) => {
                const candidates = sortRoutes(
                    routes.filter(
                        (route) =>
                            route.direction === "into" &&
                            route.vcToken.symbol.toUpperCase() === symbol
                    )
                );
                return (
                    candidates.find(
                        (route) => route.remoteChain.chainType === "BNB"
                    ) ||
                    candidates[0] ||
                    null
                );
            }).filter(Boolean),
        [routes]
    );

    useEffect(() => {
        if (!tokenOptions.length) {
            setSelectedTokenKey("");
            return;
        }

        if (!tokenOptions.some((option) => option.key === selectedTokenKey)) {
            const queryMatch = tokenOptions.find(
                (option) => option.symbol.toUpperCase() === queryToken
            );
            setSelectedTokenKey((queryMatch || tokenOptions[0]).key);
        }
    }, [selectedTokenKey, tokenOptions, queryToken]);

    useEffect(() => {
        if (!tokenRoutes.length) {
            setSelectedRouteId("");
            return;
        }

        if (!tokenRoutes.some((route) => route.id === selectedRouteId)) {
            setSelectedRouteId(tokenRoutes[0].id);
        }
    }, [selectedRouteId, tokenRoutes]);

    useEffect(() => {
        if (!selectedRoute) {
            setDestination("");
            return;
        }

        if (
            isEvmBridgeChain(selectedRoute.toChain.chainType) &&
            walletAddress
        ) {
            setDestination(walletAddress);
            return;
        }

        setDestination("");
    }, [walletAddress, selectedRoute?.id]);

    useEffect(() => {
        if (!selectedRoute) {
            setQuota(null);
            setQuotaError(null);
            return;
        }

        const controller = new AbortController();
        setQuota(null);

        async function loadQuota() {
            try {
                setQuotaLoading(true);
                setQuotaError(null);
                const params = new URLSearchParams({
                    fromChainType: selectedRoute.fromChain.chainType,
                    toChainType: selectedRoute.toChain.chainType,
                    tokenPairID: selectedRoute.tokenPairID,
                    symbol: selectedRoute.symbol,
                });
                const response = await fetch(
                    `/api/wanbridge-quota-and-fee?${params.toString()}`,
                    { signal: controller.signal }
                );
                const payload = await response.json();
                if (!response.ok || responseHasMessage(payload)) {
                    throw new Error(
                        responseHasMessage(payload)
                            ? payload.message
                            : "Could not load bridge quota"
                    );
                }
                if (!payload.success) {
                    throw new Error(
                        payload.error || "WanBridge quota unavailable"
                    );
                }
                setQuota(payload.data);
            } catch (error) {
                if (!controller.signal.aborted) {
                    setQuota(null);
                    setQuotaError(getErrorMessage(error));
                }
            } finally {
                if (!controller.signal.aborted) {
                    setQuotaLoading(false);
                }
            }
        }

        loadQuota();
        return () => controller.abort();
    }, [selectedRoute]);

    const amountValid = isPositiveDecimalAmount(amount);
    const destinationValid = validateDestination(selectedRoute, destination);
    const routeUnavailable = quotaIsUnavailable(quota);
    const withinQuota =
        selectedRoute && quota
            ? isAmountWithinQuota(
                  amount,
                  selectedRoute.fromToken.decimals,
                  quota
              )
            : false;
    const canSubmit =
        Boolean(selectedRoute) &&
        !busy &&
        !routeUnavailable &&
        amountValid &&
        destinationValid &&
        withinQuota;

    const primaryLabel = (() => {
        if (!selectedRoute) {
            return "Loading WanBridge routes";
        }
        if (!selectedRoute.supportsInAppSigning) {
            return "Open WanBridge";
        }
        if (!walletProvider) {
            return "Connect wallet";
        }
        if (busy) {
            return "Bridge transaction running";
        }
        return "Bridge with WanBridge";
    })();

    async function handlePrimaryAction() {
        if (!selectedRoute) {
            return;
        }

        if (!selectedRoute.supportsInAppSigning) {
            window.open(WANBRIDGE_WEB_URL, "_blank", "noopener,noreferrer");
            return;
        }

        if (!walletProvider || !walletAddress) {
            setActionMessage("Connect a wallet before bridging.");
            return;
        }

        if (!canSubmit) {
            setActionMessage(
                "Enter an amount and destination inside the live WanBridge quota."
            );
            return;
        }

        const sourceChain = getBridgeEvmChain(
            selectedRoute.fromChain.chainType
        );
        if (!sourceChain) {
            setActionMessage("This source chain is not signable in VinuNFT.");
            return;
        }

        setBusy(true);
        setActionMessage("Preparing WanBridge transaction...");
        setLastTx(null);
        setLastHash(null);

        try {
            await switchToBridgeChain(walletProvider, sourceChain);

            const createResponse = await fetch("/api/wanbridge-create-tx", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fromChain: selectedRoute.fromChain.chainType,
                    toChain: selectedRoute.toChain.chainType,
                    fromToken: selectedRoute.fromToken.address,
                    toToken: selectedRoute.toToken.address,
                    fromAccount: walletAddress,
                    toAccount: destination.trim(),
                    amount: amount.trim(),
                }),
            });
            const createPayload = await createResponse.json();

            if (!createResponse.ok || responseHasMessage(createPayload)) {
                throw new Error(
                    responseHasMessage(createPayload)
                        ? createPayload.message
                        : "WanBridge transaction generation failed"
                );
            }

            if (!createPayload.success) {
                throw new Error(
                    createPayload.error || "WanBridge returned no transaction"
                );
            }

            const txData = createPayload.data;
            if (!txData.tx) {
                throw new Error(
                    "WanBridge returned no EVM transaction for this route"
                );
            }

            setLastTx(txData);
            setActionMessage("Checking bridge allowance...");

            const signer = walletProvider.getSigner();

            if (txData.approveCheck) {
                const approveCheck = txData.approveCheck;
                const erc20 = new ethers.Contract(
                    approveCheck.token,
                    APPROVE_ABI,
                    signer
                );
                const currentAllowance = await erc20.allowance(
                    walletAddress,
                    approveCheck.to
                );
                const requiredAllowance = ethers.BigNumber.from(
                    approveCheck.amount
                );

                if (currentAllowance.lt(requiredAllowance)) {
                    setActionMessage("Approving WanBridge token spend...");
                    if (!currentAllowance.isZero()) {
                        const resetTx = await erc20.approve(approveCheck.to, 0);
                        await resetTx.wait();
                    }

                    const approveTx = await erc20.approve(
                        approveCheck.to,
                        approveCheck.amount
                    );
                    await approveTx.wait();
                }
            }

            setActionMessage("Sending bridge transaction...");
            const bridgeTx = await signer.sendTransaction({
                to: txData.tx.to,
                data: txData.tx.data,
                value: ethers.BigNumber.from(txData.tx.value || "0"),
            });
            await bridgeTx.wait();
            setLastHash(bridgeTx.hash);
            setActionMessage("WanBridge transaction confirmed.");
        } catch (error) {
            setActionMessage(getErrorMessage(error));
        } finally {
            setBusy(false);
        }
    }

    function selectFeatured(route) {
        setDirection(route.direction);
        setSelectedTokenKey(tokenKey(route.vcToken));
        setSelectedRouteId(route.id);
    }

    const quotaTokenDecimals = selectedRoute?.fromToken.decimals || "18";
    const nativeFeeDecimals = selectedRoute
        ? nativeFeeDecimalsForChain(selectedRoute.fromChain.chainType)
        : 18;
    const nativeFeeSymbol = selectedRoute
        ? nativeFeeSymbolForChain(
              selectedRoute.fromChain.chainType,
              selectedRoute.fromChain.chainName
          )
        : "";

    return (
        <div>
            <Helmet>
                <title>Bridge - VinuNFT</title>
                <meta
                    name="description"
                    content="Bridge assets into or out of VinuChain for VinuNFT minting, listing, and buying."
                />
            </Helmet>
            <Header />
            <main className="bridge-page">
                <section className="bridge-hero">
                    <div>
                        <p className="vinunft-page__eyebrow">
                            WanBridge on VinuNFT
                        </p>
                        <h1 className="title">
                            Bridge assets for VinuChain NFT trading.
                        </h1>
                        <p>
                            Move USDT, VINU, VC, and other supported assets into
                            or out of VinuChain for minting, listing, and buying
                            NFTs.
                        </p>
                    </div>
                    <div className="bridge-hero__status">
                        <strong>{catalog ? "Live catalog" : "Loading"}</strong>
                        <span>{routes.length || "-"} routes</span>
                        <a
                            href={WANBRIDGE_WEB_URL}
                            target="_blank"
                            rel="noreferrer"
                        >
                            Open official WanBridge
                        </a>
                    </div>
                </section>

                {catalogError ? (
                    <p className="notification is-danger">{catalogError}</p>
                ) : (
                    <></>
                )}

                {featuredRoutes.length > 0 ? (
                    <section className="bridge-featured">
                        {featuredRoutes.map((route) => (
                            <button
                                key={route.id}
                                type="button"
                                className="bridge-featured__button"
                                onClick={() => selectFeatured(route)}
                            >
                                <span>{route.vcToken.symbol}</span>
                                <small>
                                    {route.remoteChain.chainName} to VinuChain
                                </small>
                            </button>
                        ))}
                    </section>
                ) : (
                    <></>
                )}

                <section className="bridge-grid">
                    <div className="bridge-panel">
                        <h2 className="title is-4">Route</h2>
                        <div className="bridge-direction">
                            <button
                                type="button"
                                className={
                                    direction === "into" ? "is-active" : ""
                                }
                                onClick={() => setDirection("into")}
                            >
                                Into VinuChain
                            </button>
                            <button
                                type="button"
                                className={
                                    direction === "out" ? "is-active" : ""
                                }
                                onClick={() => setDirection("out")}
                            >
                                Out of VinuChain
                            </button>
                        </div>

                        <label className="field">
                            <span className="label">Token</span>
                            <span className="select is-fullwidth">
                                <select
                                    value={selectedTokenKey}
                                    onChange={(event) =>
                                        setSelectedTokenKey(event.target.value)
                                    }
                                >
                                    {tokenOptions.map((option) => (
                                        <option
                                            value={option.key}
                                            key={option.key}
                                        >
                                            {option.symbol} -{" "}
                                            {option.routeCount} routes
                                        </option>
                                    ))}
                                </select>
                            </span>
                        </label>

                        <label className="field">
                            <span className="label">Network</span>
                            <span className="select is-fullwidth">
                                <select
                                    value={selectedRoute?.id || ""}
                                    onChange={(event) =>
                                        setSelectedRouteId(event.target.value)
                                    }
                                >
                                    {tokenRoutes.map((route) => (
                                        <option value={route.id} key={route.id}>
                                            {route.fromChain.chainName} to{" "}
                                            {route.toChain.chainName}
                                        </option>
                                    ))}
                                </select>
                            </span>
                        </label>

                        <label className="field">
                            <span className="label">Amount</span>
                            <input
                                className="input"
                                value={amount}
                                onChange={(event) =>
                                    setAmount(event.target.value)
                                }
                                placeholder="0.0"
                                inputMode="decimal"
                            />
                        </label>

                        <label className="field">
                            <span className="label">Destination address</span>
                            <input
                                className="input"
                                value={destination}
                                onChange={(event) =>
                                    setDestination(event.target.value)
                                }
                                placeholder={
                                    selectedRoute?.targetNeedsCustomAddress
                                        ? "Destination account"
                                        : "0x..."
                                }
                            />
                        </label>

                        <p
                            className={
                                selectedRoute?.supportsInAppSigning
                                    ? "notification is-success"
                                    : "notification is-warning"
                            }
                        >
                            {routeDescription(selectedRoute)}
                        </p>

                        {!walletProvider ? (
                            <div className="bridge-wallet-inline">
                                <WalletButton />
                            </div>
                        ) : (
                            <></>
                        )}

                        <button
                            type="button"
                            className="button is-black bridge-primary"
                            disabled={!selectedRoute || busy}
                            onClick={handlePrimaryAction}
                        >
                            {primaryLabel}
                        </button>
                        <a
                            href={WANBRIDGE_WEB_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="bridge-official-link"
                        >
                            Continue in the official WanBridge app
                        </a>
                        {actionMessage ? (
                            <p className="notification is-info">
                                {actionMessage}
                            </p>
                        ) : (
                            <></>
                        )}
                    </div>

                    <aside className="bridge-panel">
                        <h2 className="title is-4">Quota and fee</h2>
                        {quotaLoading ? (
                            <p>Loading quota/fee...</p>
                        ) : quotaError ? (
                            <p className="notification is-danger">
                                {quotaError}
                            </p>
                        ) : !selectedRoute || !quota ? (
                            <p>Select a live WanBridge route.</p>
                        ) : routeUnavailable ? (
                            <p className="notification is-danger">
                                This WanBridge route is unavailable right now.
                            </p>
                        ) : (
                            <div className="bridge-metrics">
                                <div>
                                    <span>Minimum</span>
                                    <strong>
                                        {formatRawTokenAmount(
                                            quota.minQuota,
                                            quotaTokenDecimals
                                        )}{" "}
                                        {selectedRoute.fromToken.symbol}
                                    </strong>
                                </div>
                                <div>
                                    <span>Maximum</span>
                                    <strong>
                                        {formatRawTokenAmount(
                                            quota.maxQuota,
                                            quotaTokenDecimals
                                        )}{" "}
                                        {selectedRoute.fromToken.symbol}
                                    </strong>
                                </div>
                                <div>
                                    <span>Network fee</span>
                                    <strong>
                                        {feeLabel(
                                            quota.networkFee,
                                            nativeFeeDecimals
                                        )}{" "}
                                        {nativeFeeSymbol}
                                    </strong>
                                </div>
                                <div>
                                    <span>Operation fee</span>
                                    <strong>
                                        {feeLabel(
                                            quota.operationFee,
                                            quotaTokenDecimals
                                        )}{" "}
                                        {selectedRoute.fromToken.symbol}
                                    </strong>
                                </div>
                            </div>
                        )}

                        <div className="bridge-preview">
                            <h3 className="title is-5">Transaction preview</h3>
                            <p>
                                {selectedToken
                                    ? `${selectedToken.symbol} through ${
                                          selectedRoute?.remoteChain
                                              .chainName || "WanBridge"
                                      }`
                                    : "Choose a token to preview the route."}
                            </p>
                            {lastTx ? (
                                <dl>
                                    <dt>Receive amount</dt>
                                    <dd>{lastTx.receiveAmount || "Pending"}</dd>
                                    <dt>Bridge tx target</dt>
                                    <dd>{lastTx.tx?.to || "Pending"}</dd>
                                    {lastHash ? (
                                        <>
                                            <dt>Confirmed hash</dt>
                                            <dd>{lastHash}</dd>
                                        </>
                                    ) : (
                                        <></>
                                    )}
                                </dl>
                            ) : (
                                <p>
                                    A preview appears after WanBridge creates a
                                    transaction.
                                </p>
                            )}
                        </div>
                    </aside>
                </section>
            </main>
        </div>
    );
}
