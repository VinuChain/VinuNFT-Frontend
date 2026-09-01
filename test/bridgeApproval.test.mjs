import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { chromium } from "playwright";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
    connectWallet,
    walletCalls,
    appConfig,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

/**
 * The one place in this app where a contract address chosen by someone else
 * reaches a signing prompt.
 *
 * Everything else reads three configured contracts. The bridge asks the wallet
 * to approve an ERC-20 whose token AND spender arrive in the WanBridge API
 * response, so the user must be told which spender they are trusting before
 * they sign, not after.
 */

const wanbridge = await import("../src/common/wanbridge.js");
const { buildVinuChainRoutes } = wanbridge.default || wanbridge;

const TOKEN = ethers.utils.getAddress(
    "0x00000000000000000000000000000000000000aa"
);
const SPENDER = ethers.utils.getAddress(
    "0x00000000000000000000000000000000deadbeef"
);
const BRIDGE_TARGET = ethers.utils.getAddress(
    "0x00000000000000000000000000000000000000bb"
);
const AMOUNT_RAW = "5000000";

const ROUTES = buildVinuChainRoutes([
    {
        tokenPairID: "1",
        symbol: "USDT",
        fromChain: { chainType: "VC", chainName: "VinuChain", chainId: 207 },
        fromToken: { symbol: "USDT", decimals: 6, address: TOKEN },
        toChain: { chainType: "BNB", chainName: "BNB Chain", chainId: 56 },
        toToken: {
            symbol: "USDT",
            decimals: 18,
            address: "0x0000000000000000000000000000000000000055",
        },
    },
]);

const quotaBody = (maxQuota) => ({
    success: true,
    data: {
        minQuota: "1000000",
        maxQuota,
        networkFee: { value: "0", isPercent: false },
        operationFee: { value: "0", isPercent: false },
    },
});

/**
 * `quotas` is consumed one entry per request, so a test can make the quota move
 * between the panel the user read and the submit they clicked. The last entry
 * is reused once the list runs out.
 */
const api = (page, origin, createBody, quotas = ["1000000000"]) => {
    const seen = { createTx: 0, quota: 0 };
    page.route(`${origin}/api/**`, (route) => {
        const url = route.request().url();
        const json = (body) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(body),
            });

        if (url.includes("wanbridge-token-pairs")) {
            return json({ routes: ROUTES });
        }
        if (url.includes("wanbridge-quota-and-fee")) {
            const index = Math.min(seen.quota, quotas.length - 1);
            seen.quota += 1;
            return json(quotaBody(quotas[index]));
        }
        if (url.includes("wanbridge-create-tx")) {
            seen.createTx += 1;
            return json(createBody);
        }
        return route.abort();
    });
    return seen;
};

async function runBridge(browser, origin, createBody, options = {}) {
    const page = await browser.newPage();
    await installMockWallet(page, {
        // Default: the transaction mines, so the confirmed state is reachable.
        // `receipt: null` holds every send pending instead, parking the run at
        // the wallet prompt — which is what the disclosure test needs.
        chain: options.chain ?? {},
    });
    await routeOffline(page, origin);
    // Registered after routeOffline: Playwright gives the most recently added
    // handler precedence, and routeOffline's `**://**` would otherwise serve
    // these as static 404 HTML.
    page.seen = api(page, origin, createBody, options.quotas);
    await page.goto(`${origin}/bridge/?direction=out`, {
        waitUntil: "domcontentloaded",
    });
    await connectWallet(page);
    await page.waitForTimeout(1200);
    await page
        .locator("button", { hasText: /Out of VinuChain/ })
        .first()
        .click();
    await page.waitForTimeout(500);
    // First input is the amount; the destination is prefilled with the connected
    // account because the target chain is EVM.
    await page.locator("input").first().fill("5");
    await page.waitForTimeout(500);
    await page
        .locator("button", { hasText: /Bridge with WanBridge/i })
        .first()
        .click();
    await page.waitForTimeout(2500);
    return page;
}

test(
    "the bridge names the spender it is asking you to approve, before the prompt",
    { skip: !hasBuild },
    async () => {
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const page = await runBridge(
                browser,
                origin,
                {
                    success: true,
                    data: {
                        tx: { to: BRIDGE_TARGET, data: "0x", value: "0" },
                        approveCheck: {
                            token: TOKEN,
                            to: SPENDER,
                            amount: AMOUNT_RAW,
                        },
                    },
                },
                // Held pending, so the run parks with the wallet prompt
                // outstanding — exactly the moment the disclosure is for.
                { chain: { receipt: null } }
            );

            const sends = (await walletCalls(page)).filter(
                (call) => call.method === "eth_sendTransaction"
            );
            assert.equal(
                sends.length,
                1,
                `exactly the approval should be outstanding, got ${JSON.stringify(
                    sends
                )}`
            );
            assert.equal(
                String(sends[0].params[0].to).toLowerCase(),
                TOKEN.toLowerCase(),
                "the outstanding prompt is the ERC-20 approval"
            );

            const text = await page.evaluate(() => document.body.innerText);
            // The page previously said "Approving WanBridge token spend..." and
            // named neither address, and the allowlist check ran only after both
            // approvals had already been signed.
            assert.ok(
                text.includes(SPENDER),
                `the spender must be on screen while the wallet prompt is open: ${text.slice(
                    -600
                )}`
            );
            assert.ok(
                text.includes(TOKEN),
                "the token being approved must be named too"
            );
            assert.match(
                text,
                /cannot verify/i,
                "an address this app cannot vouch for must be described as such"
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "an approval to an address off a populated allowlist is never signed",
    { skip: !hasBuild },
    async () => {
        // WANBRIDGE_CONTRACTS ships empty, so the reject branch cannot be reached
        // through the UI. The decision itself is unit-tested here against the same
        // function the page calls; the ordering is what the browser test above
        // pins.
        const { isKnownBridgeTarget, WANBRIDGE_CONTRACTS } =
            wanbridge.default || wanbridge;
        WANBRIDGE_CONTRACTS.VC = [BRIDGE_TARGET.toLowerCase()];
        try {
            assert.equal(isKnownBridgeTarget("VC", SPENDER), false);
            assert.equal(isKnownBridgeTarget("VC", BRIDGE_TARGET), true);
        } finally {
            delete WANBRIDGE_CONTRACTS.VC;
        }
        assert.equal(isKnownBridgeTarget("VC", SPENDER), null);
    }
);

const GOOD_CREATE_TX = {
    success: true,
    data: {
        tx: { to: BRIDGE_TARGET, data: "0x", value: "0" },
        approveCheck: { token: TOKEN, to: SPENDER, amount: AMOUNT_RAW },
    },
};

// The mock wallet hashes by nonce: the approval takes nonce 0, the bridge
// transaction nonce 1.
const BRIDGE_TX_HASH = `0x${"ab".repeat(31)}01`;

test(
    "a confirmed bridge links the source-chain explorer and does not claim delivery",
    { skip: !hasBuild },
    async () => {
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const page = await runBridge(browser, origin, GOOD_CREATE_TX);

            const explorerLink = page.locator(
                `a[href="${appConfig.blockExplorer.url}/tx/${BRIDGE_TX_HASH}"]`
            );
            assert.equal(
                await explorerLink.count(),
                1,
                "the confirmed hash rendered as bare text with no link anywhere"
            );

            const text = await page.evaluate(() => document.body.innerText);
            // `tx.wait()` resolves on source-chain inclusion. WanBridge has not
            // delivered anything on the destination chain at that point.
            assert.equal(
                text.includes("WanBridge transaction confirmed."),
                false,
                text.slice(-600)
            );
            assert.match(text, /Confirmed on VinuChain/, text.slice(-600));
            assert.match(text, /deliver on BNB Chain/i, text.slice(-600));
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "an approval for a token that is not the selected route's is never signed",
    { skip: !hasBuild },
    async () => {
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const page = await runBridge(browser, origin, {
                success: true,
                data: {
                    tx: { to: BRIDGE_TARGET, data: "0x", value: "0" },
                    approveCheck: {
                        // Not the USDT the route sends. Nothing compared these
                        // two, so the wallet was asked to approve whichever
                        // contract the API named.
                        token: ethers.utils.getAddress(
                            "0x000000000000000000000000000000000000c0de"
                        ),
                        to: SPENDER,
                        amount: AMOUNT_RAW,
                    },
                },
            });

            const sends = (await walletCalls(page)).filter(
                (call) => call.method === "eth_sendTransaction"
            );
            assert.deepEqual(
                sends,
                [],
                `nothing may be signed against an unvetted token: ${JSON.stringify(
                    sends
                )}`
            );
            // Positive assertion: without it the empty-sends check passes for
            // any unrelated reason the click did nothing.
            const text = await page.evaluate(() => document.body.innerText);
            assert.match(text, /0x0*c0de/i, text.slice(-600));
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "a quota that moved since it was displayed is not silently spendable",
    { skip: !hasBuild },
    async () => {
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            // Call 1 fills the panel the user reads; call 2 is the re-check at
            // submit, by which point 5 USDT is over the maximum.
            const page = await runBridge(browser, origin, GOOD_CREATE_TX, {
                quotas: ["1000000000", "1"],
            });

            assert.equal(
                page.seen.createTx,
                0,
                "no transaction may be created against a quota that no longer holds"
            );
            const sends = (await walletCalls(page)).filter(
                (call) => call.method === "eth_sendTransaction"
            );
            assert.deepEqual(sends, []);
            const text = await page.evaluate(() => document.body.innerText);
            assert.match(text, /quota for this route changed/i, text.slice(-600));
        } finally {
            await browser.close();
            server.close();
        }
    }
);
