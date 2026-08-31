import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

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
                result: typeof result === "function" ? result(body) : result,
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
 */
export function installMockWallet(page, { account = TEST_ACCOUNT, chainId = "0xcf", reject = [] } = {}) {
    return page.addInitScript(
        ({ account, chainId, reject }) => {
            const calls = [];
            window.__walletCalls = calls;
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
                        case "eth_sendTransaction":
                            return `0x${"ab".repeat(32)}`;
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
        { account, chainId, reject }
    );
}

/** Drive the Web3Modal picker through to the injected wallet. */
export async function connectWallet(page) {
    await page.locator("button", { hasText: /connect wallet/i }).first().click();
    await page.locator("text=Connect to your MetaMask Wallet").first().click();
    await page.waitForTimeout(1200);
}

export const walletCalls = (page) => page.evaluate(() => window.__walletCalls ?? []);
