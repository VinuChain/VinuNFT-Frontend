import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
    connectWallet,
    walletCalls,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

let server;
let browser;
let origin;

before(async () => {
    if (!hasBuild) return;
    const { chromium } = await import("playwright");
    ({ server, origin } = await startStaticServer());
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

async function openPage(path = "/", walletOptions = {}, rpc = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await installMockWallet(page, walletOptions);
    await routeOffline(page, origin, { rpc });
    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    return { page, context, errors };
}

const bodyText = async (page) => (await page.textContent("body")).replace(/\s+/g, " ");

test("before connecting, the app offers to connect and hides wallet-only navigation", { skip: !hasBuild }, async () => {
    const { page, context } = await openPage();
    try {
        assert.equal(
            await page.locator("button", { hasText: /connect wallet/i }).count(),
            1
        );
        assert.ok(!(await bodyText(page)).includes("Vault"), "Vault is wallet-only");
    } finally {
        await context.close();
    }
});

test("connecting reflects the connected state in the UI", { skip: !hasBuild }, async () => {
    const { page, context, errors } = await openPage();
    try {
        await connectWallet(page);

        const text = await bodyText(page);
        assert.ok(text.includes("Change Wallet"), "the connect control must reflect the new state");
        assert.ok(text.includes("Vault"), "wallet-only navigation must appear once connected");

        const methods = (await walletCalls(page)).map((c) => c.method);
        assert.ok(methods.includes("eth_requestAccounts"), "must request accounts");
        assert.ok(methods.includes("eth_chainId"), "must establish the chain");
        assert.deepEqual(errors, [], "connecting raised uncaught errors");
    } finally {
        await context.close();
    }
});

test("a wallet on the wrong chain is reported rather than silently used", { skip: !hasBuild }, async () => {
    // 0x1 is Ethereum mainnet; VinuChain is 0xcf (207). Transacting here would
    // broadcast to the wrong network.
    const { page, context, errors } = await openPage("/", { chainId: "0x1" });
    try {
        await connectWallet(page);

        // Assert the specific alert element, not a substring: "VinuChain" is in
        // the header on every page, so a text match would pass vacuously.
        const alert = page.locator(".vinunft-header__network-alert");
        assert.equal(await alert.count(), 1, "the wrong-network alert must appear");
        assert.match(await alert.textContent(), /please switch to/i);
        assert.deepEqual(errors, [], "wrong network must not crash the page");
    } finally {
        await context.close();
    }
});

test("the wrong-network alert stays hidden on the correct chain", { skip: !hasBuild }, async () => {
    // The counterpart to the test above: an alert that is always present would
    // make that one meaningless.
    const { page, context } = await openPage("/", { chainId: "0xcf" });
    try {
        await connectWallet(page);
        assert.equal(
            await page.locator(".vinunft-header__network-alert").count(),
            0,
            "no network alert may show when the wallet is on VinuChain"
        );
    } finally {
        await context.close();
    }
});

test("declining the connection leaves the app usable and still offering to connect", { skip: !hasBuild }, async () => {
    const { page, context, errors } = await openPage("/", { reject: ["eth_requestAccounts"] });
    try {
        await page.locator("button", { hasText: /connect wallet/i }).first().click();
        await page.locator("text=Connect to your MetaMask Wallet").first().click();
        await page.waitForTimeout(1200);

        // A refused connection is a normal outcome, not a broken page.
        assert.equal(
            await page.locator("button", { hasText: /connect wallet/i }).count(),
            1,
            "the connect control must remain available after a refusal"
        );
        assert.deepEqual(errors, [], "a declined connection must not raise an uncaught error");
    } finally {
        await context.close();
    }
});

test("the mint page requires a wallet before it will submit", { skip: !hasBuild }, async () => {
    const { page, context } = await openPage("/mint/");
    try {
        const text = await bodyText(page);
        assert.ok(
            /connect/i.test(text),
            "an unconnected visitor must be told a wallet is needed"
        );
    } finally {
        await context.close();
    }
});

test("the connected account is used for chain reads, not a hard-coded address", { skip: !hasBuild }, async () => {
    const other = "0x000000000000000000000000000000000000BEEF";
    const { page, context } = await openPage("/", { account: other });
    try {
        await connectWallet(page);
        const accounts = (await walletCalls(page)).filter(
            (c) => c.method === "eth_requestAccounts"
        );
        assert.ok(accounts.length >= 1);
        assert.ok(!(await bodyText(page)).includes(TEST_ACCOUNT.slice(0, 10)));
    } finally {
        await context.close();
    }
});
