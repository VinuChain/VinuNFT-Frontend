import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { ethers } from "ethers";

// tsx wraps these CJS-interop modules once more, so the real export sits one
// `.default` deeper than a plain ESM import would put it.
const unwrap = (mod) => mod.default?.default ?? mod.default ?? mod;
const config = unwrap(await import("../../src/config.js"));
const { v1 } = unwrap(await import("../../src/common/abi.js"));

/** The app config, unwrapped once here so no test has to repeat the interop. */
export { config as appConfig };

const PUBLIC_DIR = "public";

export const hasBuild = existsSync(join(PUBLIC_DIR, "index.html"));

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".txt": "text/plain",
};

/** Serve the real production build, so CSP, bundling and hashed assets ship as-is. */
export async function startStaticServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://localhost");
            let filePath = join(PUBLIC_DIR, normalize(decodeURIComponent(url.pathname)));
            if (!filePath.startsWith(PUBLIC_DIR)) {
                res.writeHead(403).end();
                return;
            }
            const info = await stat(filePath).catch(() => null);
            if (info?.isDirectory()) filePath = join(filePath, "index.html");
            const body = await readFile(filePath);
            res.writeHead(200, {
                "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
            });
            res.end(body);
        } catch {
            res.writeHead(404, { "content-type": "text/html" }).end("not found");
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

export const ZERO_WORD = `0x${"0".repeat(64)}`;
export const DEFAULT_BLOCK = "0xe09b34";

// Only the four members the app actually calls on a payment token; it builds
// its ERC-20 contracts from inline fragments rather than a stored ABI.
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
];

const ifaces = {
    text: new ethers.utils.Interface(v1.text),
    image: new ethers.utils.Interface(v1.image),
    marketplace: new ethers.utils.Interface(v1.marketplace),
    erc20: new ethers.utils.Interface(ERC20_ABI),
};

/** Accepts "marketplace", "text", "image", a token id like "usdt", or an address. */
function resolveTarget(target) {
    const key = String(target).toLowerCase();
    for (const [name, address] of Object.entries(config.contractAddresses.v1)) {
        if (key === name || key === address.toLowerCase()) {
            return { address, iface: ifaces[name] };
        }
    }
    for (const [name, token] of Object.entries(config.tokens)) {
        if (key === name || key === token.address.toLowerCase()) {
            return { address: token.address, iface: ifaces.erc20 };
        }
    }
    throw new Error(`chainAnswers: no contract known as "${target}"`);
}

/**
 * Build the eth_call answer table: plain data only, because addInitScript
 * serialises it into the page and cannot carry functions.
 *
 * Entries with `args` answer that exact call; entries without answer every call
 * to the function, whatever the arguments. `returns` is the ethers result shape,
 * so a single tuple output takes one extra level of nesting: getListing wants
 * [[paymentToken, price, seller, amount]].
 */
export function chainAnswers(entries) {
    const table = {};
    for (const { to, fn, args, returns } of entries) {
        const { address, iface } = resolveTarget(to);
        const data = args ? iface.encodeFunctionData(fn, args) : iface.getSighash(fn);
        table[`${address.toLowerCase()}:${data.toLowerCase()}`] =
            iface.encodeFunctionResult(fn, returns);
    }
    return table;
}

/**
 * Every read /nft?type=…&id=… performs, as one table.
 *
 * The page fans out over both providers and both contracts before it renders a
 * single control, and an uncovered read is indistinguishable from a zero
 * answer — so the whole fixture has to be described in one place or each
 * journey file silently tests a different NFT. Prices are decimal strings in
 * the token's own units; `allowance` is raw base units, because that is what
 * the tests that raise it mid-run have to speak.
 */
export function nftPageAnswers({
    nftType = "text",
    id = 1,
    account = TEST_ACCOUNT,
    author = TEST_ACCOUNT,
    uri = "data:text/plain,Hello",
    totalSupply = 5,
    royaltyBps = 1000,
    platformFeeBps = 250,
    listings = [],
    balances = {},
    approvals = {},
    allowance = "0",
} = {}) {
    const nftAddress = config.contractAddresses.v1[nftType];
    const entries = [
        { to: nftType, fn: "uri", args: [id], returns: [uri] },
        { to: nftType, fn: "authorOf", args: [id], returns: [author] },
        {
            to: nftType,
            fn: "royaltyInfo",
            args: [id, 10000],
            returns: [author, royaltyBps],
        },
        { to: nftType, fn: "totalSupply", args: [id], returns: [totalSupply] },
        // Answered even though an id-1 fixture never walks `exists`, so that an
        // empty chainMisses stays a meaningful assertion.
        { to: nftType, fn: "lastTokenId", returns: [id] },
        {
            to: "marketplace",
            fn: "listingCount",
            args: [nftAddress, id],
            returns: [listings.length],
        },
        {
            to: "marketplace",
            fn: "platformFeePercentage",
            returns: [platformFeeBps],
        },
    ];

    for (const [address, balance] of Object.entries(balances)) {
        entries.push({
            to: nftType,
            fn: "balanceOf",
            args: [address, id],
            returns: [balance],
        });
    }

    for (const [address, isApproved] of Object.entries({
        [account]: false,
        ...approvals,
    })) {
        entries.push({
            to: nftType,
            fn: "isApprovedForAll",
            args: [address, config.contractAddresses.v1.marketplace],
            returns: [isApproved],
        });
    }

    listings.forEach((listing, index) => {
        const token = config.tokens[listing.paymentToken];
        const tuple = [
            token.address,
            ethers.utils.parseUnits(String(listing.price), token.decimals),
            listing.seller,
            listing.amount,
        ];
        entries.push(
            {
                to: "marketplace",
                fn: "listings",
                args: [nftAddress, id, index],
                returns: tuple,
            },
            // Same listing, but the pre-flight reads it through the tuple-
            // returning getter. Tests that stage a mid-flight change override
            // this entry alone.
            {
                to: "marketplace",
                fn: "getListing",
                args: [nftAddress, id, index],
                returns: [tuple],
            }
        );
    });

    // user.js reads an allowance for every configured token and swallows the
    // failure per token, so an uncovered one silently reads as zero and the
    // buy footer offers Approve for the wrong reason.
    for (const tokenId of Object.keys(config.tokens)) {
        entries.push({ to: tokenId, fn: "allowance", returns: [allowance] });
    }

    return chainAnswers(entries);
}

/** The same lookup the page does, for the HTTP read provider. */
export function answerCall(table, body, misses = []) {
    const call = body?.params?.[0] ?? {};
    const to = String(call.to ?? "").toLowerCase();
    const data = String(call.data ?? "").toLowerCase();
    const answer = table[`${to}:${data}`] ?? table[`${to}:${data.slice(0, 10)}`];
    if (answer === undefined) misses.push(`${to}:${data}`);
    return answer ?? ZERO_WORD;
}

/**
 * A mined receipt. `transferSingle` adds the only event any app code reads
 * (src/common/minting.js); set `status: "0x0"` — before or during a run — to
 * make the transaction fail instead.
 */
export function chainReceipt({
    transferSingle = null,
    status = "0x1",
    blockNumber = DEFAULT_BLOCK,
    to = null,
} = {}) {
    const logs = [];
    if (transferSingle) {
        const {
            nft = "text",
            operator = TEST_ACCOUNT,
            from = ethers.constants.AddressZero,
            to: recipient = TEST_ACCOUNT,
            id = 1,
            amount = 1,
        } = transferSingle;
        const { address, iface } = resolveTarget(nft);
        logs.push({
            address,
            topics: iface.encodeFilterTopics(iface.getEvent("TransferSingle"), [
                operator,
                from,
                recipient,
            ]),
            data: ethers.utils.defaultAbiCoder.encode(
                ["uint256", "uint256"],
                [id, amount]
            ),
            blockNumber,
            blockHash: `0x${"cd".repeat(32)}`,
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
        });
    }
    return {
        to,
        from: TEST_ACCOUNT,
        contractAddress: null,
        transactionIndex: "0x0",
        gasUsed: "0x5208",
        logsBloom: `0x${"00".repeat(256)}`,
        blockHash: `0x${"cd".repeat(32)}`,
        blockNumber,
        cumulativeGasUsed: "0x5208",
        effectiveGasPrice: "0x3b9aca00",
        status,
        type: "0x0",
        logs,
    };
}

/**
 * Keep runs offline and deterministic: serve the build, answer chain reads with
 * fixed values, and refuse everything else so no test depends on a third party.
 */
export function routeOffline(page, origin, { rpc = {} } = {}) {
    return page.route("**://**", async (route) => {
        const url = route.request().url();
        if (url.startsWith(origin)) return route.continue();
        if (!url.includes("rpc.vinuchain.org")) return route.abort();

        const body = JSON.parse(route.request().postData() || "{}");
        const defaults = {
            eth_chainId: "0xcf",
            net_version: "207",
            eth_blockNumber: "0xe09b34",
            eth_getLogs: [],
            eth_call: `0x${"0".repeat(64)}`,
            eth_getBalance: "0x0",
        };
        const result = rpc[body.method] ?? defaults[body.method] ?? `0x${"0".repeat(64)}`;
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                // Awaited: an override that delays its answer is how a test
                // stages a late response landing after the user has moved on.
                result: typeof result === "function" ? await result(body) : result,
            }),
        });
    });
}

export const TEST_ACCOUNT = "0x12BD0b15D5010De455DCe7944265Fe1D35a84023";

/**
 * Install a mock EIP-1193 wallet before any app code runs.
 *
 * `reject` makes the wallet refuse the given methods the way a user declining
 * in MetaMask does, so rejection handling is exercised rather than assumed.
 *
 * `chain` seeds the in-page chain state, which is published as
 * `window.__chainState` so a test can raise an allowance, drop a balance or
 * fail a receipt mid-run. It must be plain data: addInitScript serialises it,
 * so the answer lookup has to happen in the page.
 */
export function installMockWallet(
    page,
    { account = TEST_ACCOUNT, chainId = "0xcf", reject = [], chain = {} } = {}
) {
    const state = {
        answers: chain.answers ?? {},
        // Explicit null holds every transaction pending; omitted means mined.
        receipt: chain.receipt === undefined ? chainReceipt() : chain.receipt,
        blockNumber: chain.blockNumber ?? DEFAULT_BLOCK,
        gasPrice: chain.gasPrice ?? "0x3b9aca00",
        gasLimit: chain.gasLimit ?? "0x30d40",
        // Set to a message to make ethers abort before broadcasting, the way a
        // reverting pre-flight does in production.
        estimateGasError: chain.estimateGasError ?? null,
        logs: chain.logs ?? [],
        nonce: chain.nonce ?? 0,
        sent: {},
        misses: [],
    };
    return page.addInitScript(
        ({ account, chainId, reject, state, zeroWord }) => {
            const calls = [];
            window.__walletCalls = calls;
            window.__chainState = state;

            const hex = (n) => `0x${n.toString(16)}`;

            window.ethereum = {
                isMetaMask: true,
                chainId,
                selectedAddress: account,
                _events: {},
                async request({ method, params }) {
                    calls.push({ method, params });
                    if (reject.includes(method)) {
                        const error = new Error("User rejected the request.");
                        error.code = 4001;
                        throw error;
                    }
                    switch (method) {
                        case "eth_requestAccounts":
                        case "eth_accounts":
                            return [account];
                        case "eth_chainId":
                            return chainId;
                        case "net_version":
                            return String(parseInt(chainId, 16));
                        case "personal_sign":
                        case "eth_sign":
                            return `0x${"11".repeat(65)}`;
                        case "eth_call": {
                            const call = params?.[0] ?? {};
                            const to = String(call.to ?? "").toLowerCase();
                            const data = String(call.data ?? "").toLowerCase();
                            const answer =
                                state.answers[`${to}:${data}`] ??
                                state.answers[`${to}:${data.slice(0, 10)}`];
                            // A miss reads as "the contract returned zero",
                            // which is unattributable without this record.
                            if (answer === undefined) {
                                state.misses.push(`${to}:${data}`);
                            }
                            return answer ?? zeroWord;
                        }
                        case "eth_estimateGas": {
                            if (state.estimateGasError) {
                                const error = new Error(state.estimateGasError);
                                error.code = -32000;
                                throw error;
                            }
                            return state.gasLimit;
                        }
                        case "eth_gasPrice":
                            return state.gasPrice;
                        case "eth_blockNumber":
                            return state.blockNumber;
                        case "eth_getBalance":
                            return "0x0";
                        case "eth_getLogs":
                            return state.logs;
                        case "eth_getTransactionCount":
                            return hex(state.nonce);
                        case "eth_sendTransaction": {
                            const tx = params?.[0] ?? {};
                            const nonce = state.nonce++;
                            const hash = `0x${"ab".repeat(31)}${nonce
                                .toString(16)
                                .padStart(2, "0")}`;
                            // ethers polls getTransaction(hash) and throws
                            // unless every one of these comes back.
                            state.sent[hash] = {
                                hash,
                                from: tx.from ?? account,
                                to: tx.to ?? null,
                                nonce: hex(nonce),
                                gasLimit: tx.gas ?? state.gasLimit,
                                gasPrice: tx.gasPrice ?? state.gasPrice,
                                value: tx.value ?? "0x0",
                                data: tx.data ?? "0x",
                                chainId,
                                blockHash: null,
                                blockNumber: null,
                                transactionIndex: null,
                                confirmations: 0,
                            };
                            return hash;
                        }
                        case "eth_getTransactionByHash":
                            return state.sent[params?.[0]] ?? null;
                        case "eth_getTransactionReceipt": {
                            const hash = params?.[0];
                            if (!state.receipt || !state.sent[hash]) {
                                return null;
                            }
                            const sent = state.sent[hash];
                            return {
                                ...state.receipt,
                                to: state.receipt.to ?? sent.to,
                                from: sent.from,
                                transactionHash: hash,
                                logs: state.receipt.logs.map((log) => ({
                                    ...log,
                                    transactionHash: hash,
                                })),
                            };
                        }
                        case "wallet_switchEthereumChain":
                        case "wallet_addEthereumChain":
                            return null;
                        default:
                            return null;
                    }
                },
                on(event, handler) {
                    (this._events[event] = this._events[event] || []).push(handler);
                },
                removeListener() {},
                enable() {
                    return this.request({ method: "eth_requestAccounts" });
                },
            };
        },
        { account, chainId, reject, state, zeroWord: ZERO_WORD }
    );
}

/** Merge more answers into a running page, e.g. to raise an allowance. */
export const setChainAnswers = (page, answers) =>
    page.evaluate((a) => Object.assign(window.__chainState.answers, a), answers);

/** eth_calls the table did not cover: the first thing to check on a zero read. */
export const chainMisses = (page) => page.evaluate(() => window.__chainState.misses);

/**
 * The ceiling for every condition wait below.
 *
 * These runs share the machine with whatever else is building on it, so a wait
 * sized for an idle box expires while the app is still working. A condition
 * that is already true costs nothing to check, so the number is only ever
 * spent on a genuine failure.
 *
 * 30s rather than 20s because 20s was measured to expire: at load average ~40
 * on this ten-core box, `connectWallet` lost the status dot it waits for.
 */
export const CONDITION_TIMEOUT = 30000;

/** Poll an async predicate until it holds, or fail naming what never arrived. */
export async function waitUntil(
    predicate,
    { timeout = CONDITION_TIMEOUT, label = "condition" } = {}
) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/**
 * Wait until `locator` reads something `re` matches.
 *
 * Deliberately the same `textContent()` the assertions use, so a wait can
 * never accept text the assertion beside it would reject.
 */
export async function waitForTextMatch(locator, re, options = {}) {
    let last = null;
    await waitUntil(
        async () => {
            last = await locator.textContent().catch(() => null);
            return last !== null && re.test(last);
        },
        { label: `text matching ${re}`, ...options }
    ).catch((error) => {
        throw new Error(`${error.message}; last read: ${JSON.stringify(last)}`);
    });
    return last;
}

/** Wait until the mock wallet has been asked for `method` at least `count` times. */
export const waitForWalletCalls = (
    page,
    method,
    count,
    { timeout = CONDITION_TIMEOUT } = {}
) =>
    page.waitForFunction(
        ([m, n]) =>
            (window.__walletCalls ?? []).filter((c) => c.method === m).length >= n,
        [method, count],
        { timeout }
    );

/**
 * Wait for Gatsby's client runtime, which is the floor under everything React
 * does on the page.
 *
 * A floor, not a settle: it says the bundle has loaded and hydration is under
 * way, not that any chain read has come back. Anything that depends on data
 * needs its own condition on top.
 */
export const waitForHydration = (page) =>
    page.waitForFunction(() => typeof window.___navigate === "function", null, {
        timeout: CONDITION_TIMEOUT,
    });

/** Drive the Web3Modal picker through to the injected wallet. */
export async function connectWallet(page) {
    // Below the desktop breakpoint the header collapses and the wallet control
    // lives inside the burger menu — which only opens once React has hydrated,
    // so the burger is clicked until the control it reveals actually appears.
    const connect = page
        .locator("button", { hasText: /connect wallet/i })
        .first();
    const burger = page.locator(".vinunft-header__burger");
    for (let i = 0; i < 40 && !(await connect.isVisible().catch(() => false)); i++) {
        if (await burger.isVisible().catch(() => false)) {
            await burger.click().catch(() => {});
        }
        await page.waitForTimeout(250);
    }
    await connect.click();
    // On a narrow viewport Web3Modal connects the single injected wallet
    // directly instead of showing its picker, so the picker is optional.
    const picker = page.locator("text=Connect to your MetaMask Wallet").first();
    await picker
        .waitFor({ state: "visible", timeout: 2000 })
        .then(() => picker.click())
        .catch(() => {});
    // The status dot is driven by the provider the app stores on connection,
    // so it is the app's own account of being connected rather than a guess at
    // how long that takes. The chain id lands one render later, and a caller
    // that depends on it has to say so itself.
    await page
        .locator(".vinunft-wallet__status.is-connected")
        .first()
        .waitFor({ timeout: CONDITION_TIMEOUT });
}

export const walletCalls = (page) => page.evaluate(() => window.__walletCalls ?? []);
