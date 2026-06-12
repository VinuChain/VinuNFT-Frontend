import Decimal from "decimal.js";
import config from "../config";

export const WANBRIDGE_API_BASE = "https://bridge-api.wanchain.org/api";
export const WANBRIDGE_WEB_URL = "https://bridge.wanchain.org/";
export const WANBRIDGE_PARTNER = "VinuNFT";
export const VINUCHAIN_CHAIN_TYPE = "VC";
export const VINUCHAIN_TOKEN_PRIORITY = ["USDT", "VINU", "VC"];

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

export function buildVinuChainRoutes(pairs) {
    const routes = pairs.flatMap((pair) => {
        if (
            pair.fromChain?.chainType !== VINUCHAIN_CHAIN_TYPE &&
            pair.toChain?.chainType !== VINUCHAIN_CHAIN_TYPE
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

export function feeLabel(fee, decimals) {
    if (!fee) {
        return "Unavailable";
    }

    if (fee.isPercent) {
        const value = toDecimal(fee.value || "0");
        if (!value) {
            return "Unavailable";
        }
        return `${formatDecimal(value.times(100), 4)}%`;
    }

    return formatRawTokenAmount(fee.value, decimals, {
        compact: true,
        maxDecimals: 6,
    });
}
