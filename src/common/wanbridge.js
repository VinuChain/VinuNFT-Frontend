import Decimal from "decimal.js";
import config from "../config";

export const WANBRIDGE_API_BASE = "https://bridge-api.wanchain.org/api";
export const WANBRIDGE_WEB_URL = "https://bridge.wanchain.org/";
export const WANBRIDGE_PARTNER = "VinuNFT";
export const VINUCHAIN_CHAIN_TYPE = "VC";
export const VINUCHAIN_TOKEN_PRIORITY = ["USDT", "VINU", "VC"];

// The upstream tokenPairs response is ~212 KB and measured at 3.5s from a
// developer machine; from a serverless region it is slower still. 10s was
// close enough to that to abort legitimately-slow calls, which surfaced as a
// bare 502 with no way to tell a timeout from a refusal. The platform
// function ceiling is far above this, so the bound is still real.
const WANBRIDGE_TIMEOUT_MS = Number(process.env.WANBRIDGE_TIMEOUT_MS || 20000);
const WANBRIDGE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Carries why the upstream call failed.
 *
 * `reason` is a fixed enum, safe to return to a browser: it describes OUR call,
 * not the upstream's content. `status` is the upstream HTTP status when there
 * was one. Together they separate "they timed out" from "they refused us" from
 * "they answered with something that is not JSON", which is the distinction a
 * 502 alone cannot make and which cost a production outage its diagnosis.
 */
export const WANBRIDGE_FAILURE = {
    TIMEOUT: "upstream_timeout",
    NETWORK: "upstream_unreachable",
    STATUS: "upstream_status",
    BODY: "upstream_not_json",
    TOO_LARGE: "upstream_too_large",
};

export class WanBridgeUpstreamError extends Error {
    constructor(message, { reason, status = null } = {}) {
        super(message);
        this.name = "WanBridgeUpstreamError";
        this.reason = reason;
        this.status = status;
    }
}

// Every proxy reaches the same third-party API, so the bound belongs here once
// rather than three times. Without it a hung or hostile upstream holds the
// serverless invocation to the platform ceiling and buffers an unbounded body.
// ponytail: a chunked response with no content-length is still fully buffered
// by text() before the length check; stream it if this upstream goes chunked.
export async function fetchWanBridgeJson(path, init = {}) {
    let response;
    try {
        response = await fetch(`${WANBRIDGE_API_BASE}/${path}`, {
            ...init,
            signal: AbortSignal.timeout(WANBRIDGE_TIMEOUT_MS),
        });
    } catch (error) {
        // Name the cause. Every failure here previously collapsed into one
        // opaque 502, so a timeout, a DNS failure and an upstream refusal were
        // indistinguishable from a log — which is precisely what made the
        // production outage on this endpoint impossible to diagnose remotely.
        const cause =
            error?.name === "TimeoutError" || error?.name === "AbortError"
                ? `timed out after ${WANBRIDGE_TIMEOUT_MS}ms`
                : `${error?.name ?? "Error"}: ${error?.message ?? "unknown"}`;
        throw new WanBridgeUpstreamError(
            `WanBridge ${path} unreachable (${cause})`,
            {
                reason:
                    error?.name === "TimeoutError" ||
                    error?.name === "AbortError"
                        ? WANBRIDGE_FAILURE.TIMEOUT
                        : WANBRIDGE_FAILURE.NETWORK,
            }
        );
    }

    if (
        Number(response.headers.get("content-length")) >
        WANBRIDGE_MAX_RESPONSE_BYTES
    ) {
        throw new WanBridgeUpstreamError("WanBridge response too large", {
            reason: WANBRIDGE_FAILURE.TOO_LARGE,
            status: response.status,
        });
    }

    const body = await response.text();
    if (body.length > WANBRIDGE_MAX_RESPONSE_BYTES) {
        throw new WanBridgeUpstreamError("WanBridge response too large", {
            reason: WANBRIDGE_FAILURE.TOO_LARGE,
            status: response.status,
        });
    }

    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        // An upstream that answers 200 with an HTML challenge, a proxy error
        // page or a WAF interstitial lands here. Unguarded, JSON.parse threw a
        // bare SyntaxError with no status and no hint of what came back, which
        // is indistinguishable from a network failure by the time a proxy
        // catches it. The body itself is never carried out of this function.
        throw new WanBridgeUpstreamError(
            `WanBridge ${path} answered ${response.status} with ${
                body.trimStart().startsWith("<") ? "markup" : "non-JSON"
            }, not JSON`,
            { reason: WANBRIDGE_FAILURE.BODY, status: response.status }
        );
    }

    return { ok: response.ok, status: response.status, payload };
}

const BRIDGE_NATIVE_FEE_DECIMALS = {
    BTC: 8,
    SOL: 9,
    TRX: 6,
};

const BRIDGE_NATIVE_FEE_SYMBOLS = {
    BTC: "BTC",
    SOL: "SOL",
    TRX: "TRX",
};

export const BRIDGE_EVM_CHAINS = [
    {
        chainType: "VC",
        chainId: config.networks.main.chainId,
        name: "VinuChain",
        currency: config.nativeCurrency.symbol,
        explorerUrl: config.blockExplorer.url,
        rpcUrl: config.rpc,
    },
    {
        chainType: "BNB",
        chainId: 56,
        name: "BNB Chain",
        currency: "BNB",
        explorerUrl: "https://bscscan.com",
        rpcUrl: "https://bsc-dataseed.binance.org",
    },
    {
        chainType: "ETH",
        chainId: 1,
        name: "Ethereum",
        currency: "ETH",
        explorerUrl: "https://etherscan.io",
        rpcUrl: "https://ethereum-rpc.publicnode.com",
    },
    {
        chainType: "MATIC",
        chainId: 137,
        name: "Polygon",
        currency: "POL",
        explorerUrl: "https://polygonscan.com",
        rpcUrl: "https://polygon-rpc.com",
    },
    {
        chainType: "ARETH",
        chainId: 42161,
        name: "Arbitrum",
        currency: "ETH",
        explorerUrl: "https://arbiscan.io",
        rpcUrl: "https://arb1.arbitrum.io/rpc",
    },
    {
        chainType: "AVAX",
        chainId: 43114,
        name: "Avalanche C-Chain",
        currency: "AVAX",
        explorerUrl: "https://snowtrace.io",
        rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    },
    {
        chainType: "BASEETH",
        chainId: 8453,
        name: "Base",
        currency: "ETH",
        explorerUrl: "https://basescan.org",
        rpcUrl: "https://mainnet.base.org",
    },
    {
        chainType: "OETH",
        chainId: 10,
        name: "OP Mainnet",
        currency: "ETH",
        explorerUrl: "https://optimistic.etherscan.io",
        rpcUrl: "https://mainnet.optimism.io",
    },
    {
        chainType: "WAN",
        chainId: 888,
        name: "Wanchain",
        currency: "WAN",
        explorerUrl: "https://wanscan.org",
        rpcUrl: "https://gwan-ssl.wandevs.org:56891",
    },
];

const BRIDGE_EVM_CHAIN_MAP = new Map(
    BRIDGE_EVM_CHAINS.map((chain) => [chain.chainType, chain])
);

const ZERO_QUOTA_RE = /^0(?:\.0+)?(?:e\+?0+)?$/i;

// Known WanBridge cross-chain router/escrow contract addresses per chainType.
// TODO: populate from WanBridge's published cross-chain contract registry
// (https://bridge.wanchain.org). Left empty pending authoritative source —
// all chains degrade to the display-and-confirm path until populated.
export const WANBRIDGE_CONTRACTS = {
    // chainType: ["0x<lowercased known bridge contract>", ...]
    // Example once sourced: VC: ["0x<router>"]
};

// Returns true if toAddress is a known WanBridge contract for chainType,
// false if the chain is catalogued but the address is not on the list,
// or null if the chain has no entries yet (caller decides — degrade to display).
export function isKnownBridgeTarget(chainType, toAddress) {
    const list = WANBRIDGE_CONTRACTS[chainType];
    if (!list || list.length === 0) return null; // unknown — caller decides
    return list
        .map((a) => a.toLowerCase())
        .includes(String(toAddress).toLowerCase());
}

export function isEvmBridgeChain(chainType) {
    return BRIDGE_EVM_CHAIN_MAP.has(chainType);
}

export function getBridgeEvmChain(chainType) {
    return BRIDGE_EVM_CHAIN_MAP.get(chainType) || null;
}

export function nativeFeeDecimalsForChain(chainType) {
    return BRIDGE_NATIVE_FEE_DECIMALS[chainType] || 18;
}

export function nativeFeeSymbolForChain(chainType, fallback) {
    return (
        getBridgeEvmChain(chainType)?.currency ||
        BRIDGE_NATIVE_FEE_SYMBOLS[chainType] ||
        fallback
    );
}

export function toHexChainId(chainId) {
    return `0x${Number(chainId).toString(16)}`;
}

// The catalog is a third-party feed and its `decimals` is what scales the raw
// amount the wallet ends up signing, so a wrong one is a wrong transfer, not a
// wrong label. src/config.js is ground truth for the VinuChain tokens this app
// already knows; a pair that disagrees, or that carries a nonsensical decimals
// at all, is dropped rather than mis-scaled.
function tokenDecimalsAreUsable(token) {
    const decimals = Number(token?.decimals);
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36;
}

function vinuChainDecimalsMatchConfig(token) {
    const address = String(token?.address || "").toLowerCase();
    const configured = Object.values(config.tokens).find(
        (entry) => entry.address.toLowerCase() === address
    );
    return !configured || Number(token.decimals) === configured.decimals;
}

export function buildVinuChainRoutes(pairs) {
    const routes = pairs.flatMap((pair) => {
        if (
            pair.fromChain?.chainType !== VINUCHAIN_CHAIN_TYPE &&
            pair.toChain?.chainType !== VINUCHAIN_CHAIN_TYPE
        ) {
            return [];
        }

        const vcToken =
            pair.fromChain.chainType === VINUCHAIN_CHAIN_TYPE
                ? pair.fromToken
                : pair.toToken;

        if (
            !tokenDecimalsAreUsable(pair.fromToken) ||
            !tokenDecimalsAreUsable(pair.toToken) ||
            !vinuChainDecimalsMatchConfig(vcToken)
        ) {
            return [];
        }

        return [buildRoute(pair, true), buildRoute(pair, false)];
    });

    return routes.sort(compareBridgeRoutes);
}

function buildRoute(pair, originalDirection) {
    const fromChain = originalDirection ? pair.fromChain : pair.toChain;
    const toChain = originalDirection ? pair.toChain : pair.fromChain;
    const fromToken = originalDirection ? pair.fromToken : pair.toToken;
    const toToken = originalDirection ? pair.toToken : pair.fromToken;
    const vcToken =
        pair.fromChain.chainType === VINUCHAIN_CHAIN_TYPE
            ? pair.fromToken
            : pair.toToken;
    const remoteChain =
        pair.fromChain.chainType === VINUCHAIN_CHAIN_TYPE
            ? pair.toChain
            : pair.fromChain;
    const remoteToken =
        pair.fromChain.chainType === VINUCHAIN_CHAIN_TYPE
            ? pair.toToken
            : pair.fromToken;

    return {
        id: `${pair.tokenPairID}:${fromChain.chainType}:${toChain.chainType}`,
        tokenPairID: pair.tokenPairID,
        symbol: vcToken.symbol || pair.symbol,
        direction: toChain.chainType === VINUCHAIN_CHAIN_TYPE ? "into" : "out",
        fromChain,
        toChain,
        fromToken,
        toToken,
        vcToken,
        remoteChain,
        remoteToken,
        priorityRank: priorityRank(vcToken.symbol || pair.symbol),
        supportsInAppSigning: isEvmBridgeChain(fromChain.chainType),
        targetNeedsCustomAddress: !isEvmBridgeChain(toChain.chainType),
    };
}

function compareBridgeRoutes(left, right) {
    if (left.priorityRank !== right.priorityRank) {
        return left.priorityRank - right.priorityRank;
    }

    if (left.supportsInAppSigning !== right.supportsInAppSigning) {
        return left.supportsInAppSigning ? -1 : 1;
    }

    return `${left.symbol}-${left.remoteChain.chainName}`.localeCompare(
        `${right.symbol}-${right.remoteChain.chainName}`
    );
}

export function priorityRank(symbol) {
    const index = VINUCHAIN_TOKEN_PRIORITY.indexOf(symbol.toUpperCase());
    return index === -1 ? VINUCHAIN_TOKEN_PRIORITY.length + 1 : index;
}

export function tokenKey(token) {
    return `${token.symbol.toUpperCase()}:${token.address.toLowerCase()}`;
}

function toDecimal(value) {
    try {
        const decimal = new Decimal(value);
        return decimal.isFinite() ? decimal : null;
    } catch (e) {
        return null;
    }
}

function formatDecimal(value, maxDecimals) {
    const rounded = value.toDecimalPlaces(maxDecimals, Decimal.ROUND_DOWN);
    const fixed = rounded.toFixed(maxDecimals);
    return fixed.replace(/\.?0+$/, "");
}

export function formatRawTokenAmount(rawValue, decimals, options = {}) {
    if (rawValue === null || rawValue === undefined || rawValue === "") {
        return "Unavailable";
    }

    const value = toDecimal(rawValue);
    if (!value) {
        return String(rawValue);
    }

    const normalized = value.div(new Decimal(10).pow(Number(decimals) || 0));
    if (normalized.isZero()) {
        return "0";
    }

    const maxDecimals = options.maxDecimals || 6;

    if (options.compact && normalized.greaterThanOrEqualTo(1000000)) {
        if (normalized.greaterThanOrEqualTo(1000000000)) {
            return `${formatDecimal(normalized.div(1000000000), 2)}B`;
        }

        return `${formatDecimal(normalized.div(1000000), 2)}M`;
    }

    return formatDecimal(normalized, maxDecimals);
}

export function decimalAmountToRaw(amount, decimals) {
    const trimmed = amount.trim();
    if (!trimmed || !/^(?:\d+|\d*\.\d+)$/.test(trimmed)) {
        return null;
    }

    const parsed = toDecimal(trimmed);
    if (!parsed || parsed.lessThanOrEqualTo(0)) {
        return null;
    }

    return parsed
        .times(new Decimal(10).pow(Number(decimals) || 0))
        .toDecimalPlaces(0, Decimal.ROUND_DOWN);
}

export function isPositiveDecimalAmount(amount) {
    return decimalAmountToRaw(amount, 0) !== null;
}

export function isAmountWithinQuota(amount, decimals, quota) {
    if (!quota) {
        return false;
    }

    const rawAmount = decimalAmountToRaw(amount, decimals);
    const min = toDecimal(quota.minQuota || "0");
    const max = toDecimal(quota.maxQuota || "0");

    if (
        !rawAmount ||
        !min ||
        !max ||
        min.lessThan(0) ||
        max.lessThan(0) ||
        max.isZero()
    ) {
        return false;
    }

    if (rawAmount.lessThan(min)) {
        return false;
    }

    if (rawAmount.greaterThan(max)) {
        return false;
    }

    return true;
}

export function quotaIsUnavailable(quota) {
    if (!quota) {
        return false;
    }
    return ZERO_QUOTA_RE.test(String(quota.maxQuota || "0"));
}

// `rawAmount` is the transfer size in the from-token's raw units, or null when
// nothing has been entered yet.
export function feeLabel(fee, decimals, symbol, rawAmount = null) {
    if (!fee) {
        return "Unavailable";
    }

    const amount = (raw) => {
        const text = formatRawTokenAmount(raw, decimals, {
            compact: true,
            maxDecimals: 6,
        });
        return symbol && text !== "Unavailable" ? `${text} ${symbol}` : text;
    };

    if (fee.isPercent) {
        const rate = toDecimal(fee.value || "0");
        if (!rate) {
            return "Unavailable";
        }

        // WanBridge denominates minFeeLimit/maxFeeLimit in the from-token's raw
        // units (verified on pair 536 in both directions: 200000 at 6 decimals
        // out of VinuChain, 200000000000000000 at 18 into it — the same 0.2
        // USDT). The rate alone understates every transfer under the floor, and
        // the floor is where most of them sit: on VC->BNB USDT it is 0.2 on a
        // 0.4 minimum transfer, so the honest number is 125x the percentage.
        const floor = fee.minFeeLimit ? toDecimal(fee.minFeeLimit) : null;
        const ceiling = fee.maxFeeLimit ? toDecimal(fee.maxFeeLimit) : null;

        if (rawAmount) {
            let charged = new Decimal(rawAmount).times(rate);
            if (floor && charged.lessThan(floor)) {
                charged = floor;
            }
            if (ceiling && charged.greaterThan(ceiling)) {
                charged = ceiling;
            }
            return amount(charged.toDecimalPlaces(0, Decimal.ROUND_DOWN));
        }

        const percent = `${formatDecimal(rate.times(100), 4)}%`;
        const band = [
            floor ? `min ${amount(floor)}` : null,
            ceiling ? `max ${amount(ceiling)}` : null,
        ].filter(Boolean);
        return band.length ? `${percent} (${band.join(", ")})` : percent;
    }

    return amount(fee.value);
}

// The token, the spender and the call target in a WanBridge createTx2 response
// are all chosen by a third party, but the route the user picked is local
// ground truth — so the token being approved can be checked against it before
// anything reaches a wallet prompt. The target checks stay inert until
// WANBRIDGE_CONTRACTS is populated; the token check bites today.
export function validateBridgeTx(route, txData) {
    const approveToken = txData?.approveCheck?.token;
    if (
        approveToken &&
        String(approveToken).toLowerCase() !==
            String(route.fromToken.address).toLowerCase()
    ) {
        return `WanBridge asked to approve ${approveToken}, which is not the ${route.fromToken.symbol} token this route sends (${route.fromToken.address}). Aborting for safety.`;
    }

    for (const target of [txData?.tx?.to, txData?.approveCheck?.to]) {
        if (
            target &&
            isKnownBridgeTarget(route.fromChain.chainType, target) === false
        ) {
            return `${target} is not a known WanBridge contract on ${route.fromChain.chainName}. Aborting for safety.`;
        }
    }

    return null;
}
