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

const api = (page, origin, createBody) =>
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
            return json({
                success: true,
                data: {
                    minQuota: "1000000",
                    maxQuota: "1000000000",
                    networkFee: { value: "0", isPercent: false },
                    operationFee: { value: "0", isPercent: false },
                },
            });
        }
        if (url.includes("wanbridge-create-tx")) {
            return json(createBody);
        }
        return route.abort();
    });

async function runBridge(browser, origin, createBody) {
    const page = await browser.newPage();
    await installMockWallet(page, {
        // The receipt is held pending, so the run parks with the wallet prompt
        // outstanding — which is exactly the moment the disclosure is for.
        chain: { receipt: null },
    });
    await routeOffline(page, origin);
    await api(page, origin, createBody);
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
            const page = await runBridge(browser, origin, {
                success: true,
                data: {
                    tx: { to: BRIDGE_TARGET, data: "0x", value: "0" },
                    approveCheck: {
                        token: TOKEN,
                        to: SPENDER,
                        amount: AMOUNT_RAW,
                    },
                },
            });

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
