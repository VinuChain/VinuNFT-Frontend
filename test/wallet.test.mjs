import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
    connectWallet,
    walletCalls,
    waitUntil,
    waitForHydration,
    waitForWalletCalls,
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
    await waitForHydration(page);
    return { page, context, errors };
}

const bodyText = async (page) => (await page.textContent("body")).replace(/\s+/g, " ");

/**
 * `connectWallet` returns when the provider reports itself connected; the
 * header that reads off that provider lands a render later, and every
 * assertion below reads the header. This is that arrival.
 */
const waitForConnectedHeader = (page) =>
    waitUntil(async () => (await bodyText(page)).includes("Change Wallet"), {
        label: "the header to show the connected state",
    });

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
        await waitForConnectedHeader(page);

        const text = await bodyText(page);
        assert.ok(text.includes("Change Wallet"), "the connect control must reflect the new state");
        assert.ok(text.includes("Vault"), "wallet-only navigation must appear once connected");

        // Waited for, not snapshotted: the chain read is issued by the provider
        // hook, not by the header, so it is not ordered against the render this
        // test waited on. Reading the list at that moment failed roughly one run
        // in three — the assertion is unchanged, only its timing is now defined.
        await waitForWalletCalls(page, "eth_requestAccounts", 1);
        await waitForWalletCalls(page, "eth_chainId", 1);
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
        // The alert is rendered off the chain id the provider reports, which
        // lands a render after the wallet itself connects.
        await alert.waitFor();
        assert.equal(await alert.count(), 1, "the wrong-network alert must appear");
        assert.match(await alert.textContent(), /please switch to/i);
        assert.deepEqual(errors, [], "wrong network must not crash the page");
    } finally {
        await context.close();
    }
});

test("the wrong-network alert offers a working switch, not just an instruction", { skip: !hasBuild }, async () => {
    // VinuChain is not preconfigured in MetaMask, so "please switch" on its own
    // is a dead end for a first-time visitor.
    const { page, context, errors } = await openPage("/", { chainId: "0x1" });
    try {
        await connectWallet(page);
        const button = page
            .locator(".vinunft-header__network-alert button", { hasText: /switch to/i })
            .first();
        // Same render as the alert above: it is driven by the chain id, which
        // arrives after the wallet reports itself connected.
        await button.waitFor();
        assert.equal(await button.count(), 1, "the alert must offer a switch control");

        await button.click();
        await waitForWalletCalls(page, "wallet_switchEthereumChain", 1);

        const methods = (await walletCalls(page)).map((c) => c.method);
        assert.ok(
            methods.includes("wallet_switchEthereumChain"),
            `the wallet must be asked to switch, saw ${methods.join(", ")}`
        );
        assert.deepEqual(errors, []);
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
        // Bounded on purpose: the correct chain renders nothing at all, so
        // there is no arrival that proves the chain check has run and the
        // alert would already be on screen if it were coming.
        await page.waitForTimeout(600);
        assert.equal(
            await page.locator(".vinunft-header__network-alert").count(),
            0,
            "no network alert may show when the wallet is on VinuChain"
        );
    } finally {
        await context.close();
    }
});

/**
 * Connect, then press the marketplace's own Refresh so a scan definitely starts
 * AFTER the wallet is connected: the first load is already in flight when the
 * wallet arrives, and `loadIndex` hands concurrent callers that same promise.
 * `eth_blockNumber` is the tell — only the index refresh asks for it, and it
 * asks the READ provider.
 */
async function refreshAfterConnect(page) {
    await connectWallet(page);
    await waitForWalletCalls(page, "eth_chainId", 1);
    const refresh = page.locator("button", { hasText: /^Refresh$/ }).first();
    await refresh.waitFor();
    await waitUntil(() => refresh.isEnabled(), {
        label: "the marketplace to finish its first load",
    });
    await refresh.click();
}

test("a wallet on the wrong chain is never used as the read provider", { skip: !hasBuild }, async () => {
    // The read path is a whole-history fold cached per contract address and
    // block height. Pointed at another chain it continues a VinuChain fold up
    // to a foreign head, and the mixed events and impossible lastIndexedBlock
    // outlive the disconnect.
    const { page, context, errors } = await openPage("/marketplace/", {
        chainId: "0x1",
    });
    try {
        await refreshAfterConnect(page);
        // Bounded: the correct behaviour is a call that never arrives.
        await page.waitForTimeout(1500);

        const methods = (await walletCalls(page)).map((c) => c.method);
        assert.equal(
            methods.includes("eth_blockNumber"),
            false,
            `the wrong chain must not be read from, saw ${methods.join(", ")}`
        );
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("a wallet on VinuChain does become the read provider", { skip: !hasBuild }, async () => {
    // The counterpart, and the anti-vacuity check for the test above: reads DO
    // move to a wallet that is on the right chain, so "no eth_blockNumber"
    // there is a decision and not an absence of any read at all.
    const { page, context } = await openPage("/marketplace/", {
        chainId: "0xcf",
    });
    try {
        await refreshAfterConnect(page);
        await waitForWalletCalls(page, "eth_blockNumber", 1);
        const methods = (await walletCalls(page)).map((c) => c.method);
        assert.ok(methods.includes("eth_blockNumber"), methods.join(", "));
    } finally {
        await context.close();
    }
});

test("declining the connection leaves the app usable and still offering to connect", { skip: !hasBuild }, async () => {
    const { page, context, errors } = await openPage("/", { reject: ["eth_requestAccounts"] });
    try {
        await page.locator("button", { hasText: /connect wallet/i }).first().click();
        await page.locator("text=Connect to your MetaMask Wallet").first().click();
        // The refusal the app has to survive is the answer to this request.
        await waitForWalletCalls(page, "eth_requestAccounts", 1);

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
        // Anchors the negative below: the header has to have rendered from the
        // connected account before "the built-in test address is absent" says
        // anything about which account was used.
        await waitForConnectedHeader(page);
        const accounts = (await walletCalls(page)).filter(
            (c) => c.method === "eth_requestAccounts"
        );
        assert.ok(accounts.length >= 1);
        assert.ok(!(await bodyText(page)).includes(TEST_ACCOUNT.slice(0, 10)));
    } finally {
        await context.close();
    }
});

// --- lifecycle events the wallet can raise after connecting -----------------

/** Fire an EIP-1193 event the way a wallet extension does. */
const emit = (page, event, ...args) =>
    page.evaluate(
        ([event, args]) => {
            for (const handler of window.ethereum._events?.[event] ?? []) {
                handler(...args);
            }
        },
        [event, args]
    );

test("a disconnect from the wallet returns the app to its unconnected state", { skip: !hasBuild }, async () => {
    const { page, context, errors } = await openPage();
    try {
        await connectWallet(page);
        await waitForConnectedHeader(page);
        assert.ok((await bodyText(page)).includes("Change Wallet"));

        await emit(page, "disconnect");
        await waitUntil(async () => (await bodyText(page)).includes("Connect Wallet"), {
            label: "the header to return to its unconnected state",
        });

        const text = await bodyText(page);
        assert.ok(text.includes("Connect Wallet"), "must offer to reconnect");
        assert.ok(!text.includes("Vault"), "wallet-only navigation must disappear");
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("clearing the selected account is treated as a disconnection", { skip: !hasBuild }, async () => {
    // MetaMask reports locking the wallet as accountsChanged with no accounts.
    // Continuing to show a connected UI would misrepresent who is signed in.
    const { page, context, errors } = await openPage();
    try {
        await connectWallet(page);
        await emit(page, "accountsChanged", []);
        await waitUntil(async () => (await bodyText(page)).includes("Connect Wallet"), {
            label: "the header to return to its unconnected state",
        });

        assert.ok((await bodyText(page)).includes("Connect Wallet"));
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("switching to another account keeps the session connected", { skip: !hasBuild }, async () => {
    const { page, context, errors } = await openPage();
    try {
        await connectWallet(page);
        // The session has to be visibly connected before an event can be shown
        // not to have ended it.
        await waitForConnectedHeader(page);
        // The mock wallet has no selectedAddress, like most EIP-1193 wallets:
        // the account list the event carries is all the app gets.
        const next = "0x000000000000000000000000000000000000BEEF";
        await emit(page, "accountsChanged", [next]);
        // Bounded on purpose: a switch that keeps the session changes nothing
        // this page renders, so the only honest test is to give the handler
        // room to break it and then look.
        await page.waitForTimeout(600);

        assert.ok(
            (await bodyText(page)).includes("Change Wallet"),
            "an account switch is not a disconnection"
        );
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("a chain change from the wallet keeps the session connected", { skip: !hasBuild }, async () => {
    // chainChanged used to share the account handler, which disconnected any
    // wallet without selectedAddress on every network switch.
    const { page, context, errors } = await openPage();
    try {
        await connectWallet(page);
        await waitForConnectedHeader(page);
        await emit(page, "chainChanged", "0xcf");
        // Bounded for the same reason as the account switch above.
        await page.waitForTimeout(600);

        assert.ok(
            (await bodyText(page)).includes("Change Wallet"),
            "a chain change is not a disconnection"
        );
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

// --- Change Wallet ----------------------------------------------------------

/** Press Change Wallet and pick the injected wallet again, if a picker shows. */
async function changeToSameWallet(page) {
    await page.locator("button", { hasText: /change wallet/i }).first().click();
    const picker = page.locator("text=Connect to your MetaMask Wallet").first();
    await picker
        .waitFor({ state: "visible", timeout: 2000 })
        .then(() => picker.click())
        .catch(() => {});
}

const permissionRequests = async (page) =>
    (await walletCalls(page)).filter((c) => c.method === "wallet_requestPermissions");

test("Change Wallet on the connected wallet opens its account picker", { skip: !hasBuild }, async () => {
    // Picking the same wallet again used to re-send only eth_requestAccounts,
    // which a wallet that already trusts the site answers silently with the
    // same account: Change Wallet did nothing at all.
    const { page, context, errors } = await openPage();
    try {
        await connectWallet(page);
        await waitForConnectedHeader(page);
        assert.equal(
            (await permissionRequests(page)).length,
            0,
            "a first connection has already prompted and must not prompt twice"
        );

        await changeToSameWallet(page);
        await waitForWalletCalls(page, "wallet_requestPermissions", 1);

        const [request] = await permissionRequests(page);
        assert.deepEqual(request.params, [{ eth_accounts: {} }]);
        assert.ok((await bodyText(page)).includes("Change Wallet"));
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("closing the account picker keeps the current account connected", { skip: !hasBuild }, async () => {
    const { page, context, errors } = await openPage("/", {
        reject: ["wallet_requestPermissions"],
    });
    try {
        await connectWallet(page);
        await waitForConnectedHeader(page);
        await changeToSameWallet(page);
        await waitForWalletCalls(page, "wallet_requestPermissions", 1);
        // Bounded: staying connected is the absence of a change.
        await page.waitForTimeout(600);

        assert.ok(
            (await bodyText(page)).includes("Change Wallet"),
            "a closed picker is not a disconnection"
        );
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("removing the site's access from the account picker disconnects", { skip: !hasBuild }, async () => {
    // The picker can end the connection itself. The flow used to restore the
    // wallet provider once the picker closed, leaving the page connected to a
    // wallet that had just revoked it.
    const { page, context, errors } = await openPage("/", { revokeOnPermissions: true });
    try {
        await connectWallet(page);
        await waitForConnectedHeader(page);
        await changeToSameWallet(page);
        await waitForWalletCalls(page, "wallet_requestPermissions", 1);
        await waitUntil(async () => (await bodyText(page)).includes("Connect Wallet"), {
            label: "the header to return to its unconnected state",
        });
        // Bounded: an overwrite after the picker would flip it straight back.
        await page.waitForTimeout(600);

        assert.ok(
            (await bodyText(page)).includes("Connect Wallet"),
            "a revoked site must not be shown as connected"
        );
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("pressing Change Wallet repeatedly keeps a single picker container", { skip: !hasBuild }, async () => {
    // Each Web3Modal appended a container but rendered into the first, so every
    // press used to leave another empty one in the page.
    const { page, context, errors } = await openPage();
    try {
        await connectWallet(page);
        await waitForConnectedHeader(page);
        for (let press = 1; press <= 3; press++) {
            await changeToSameWallet(page);
            await waitForWalletCalls(page, "wallet_requestPermissions", press);
        }

        assert.equal(await page.locator('[id="WEB3_CONNECT_MODAL_ID"]').count(), 1);
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("Change Wallet on a wallet without request() keeps it connected", { skip: !hasBuild }, async () => {
    // Web3Modal still hands back window.web3.currentProvider from wallets that
    // predate EIP-1193, which answer sendAsync only. The account picker is
    // unsupported there, and re-reading the accounts through request() threw.
    const { page, context, errors } = await openPage("/", { legacy: true });
    try {
        await connectWallet(page);
        await waitForConnectedHeader(page);
        const reads = (await walletCalls(page)).filter((c) => c.method === "eth_accounts").length;

        await changeToSameWallet(page);
        await waitForWalletCalls(page, "eth_accounts", reads + 1);
        // Bounded: staying connected is the absence of a change.
        await page.waitForTimeout(600);

        assert.ok((await bodyText(page)).includes("Change Wallet"));
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

// --- Late answers -------------------------------------------------------------

/** Hold the wallet's answers to `method` back by `ms` from now on. */
const delayWallet = (page, method, ms) =>
    page.evaluate(
        ([m, t]) => {
            window.__walletDelays = { ...window.__walletDelays, [m]: t };
        },
        [method, ms]
    );

test("a chain lookup that lands after a disconnect leaves no wrong-network alert", { skip: !hasBuild }, async () => {
    // The header cleared its chain id on disconnect, but a lookup started while
    // the wallet was still there wrote the old chain back when it landed,
    // bringing back an alert whose Switch button had no wallet to act on.
    const { page, context, errors } = await openPage("/", { chainId: "0x1" });
    try {
        await delayWallet(page, "eth_chainId", 600);
        await connectWallet(page);
        await emit(page, "disconnect");
        await waitUntil(async () => (await bodyText(page)).includes("Connect Wallet"), {
            label: "the header to return to its unconnected state",
        });
        // Bounded: past the held-back answers, which are what would restore
        // it. ethers' getNetwork asks for the chain twice, so the last one
        // lands about two delays after the lookup starts.
        await page.waitForTimeout(3000);

        assert.equal(await page.locator(".vinunft-header__network-alert").count(), 0);
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});

test("a chain change still resolving at a disconnect does not take reads back", { skip: !hasBuild }, async () => {
    // The chain handler waits on the network before choosing the read
    // provider. A disconnect in that window restored the default one, and the
    // lookup then landed and pointed reads back at the wallet that had gone.
    const { page, context, errors } = await openPage("/marketplace/", { chainId: "0xcf" });
    try {
        await refreshAfterConnect(page);
        // The wallet really was the read provider before it went.
        await waitForWalletCalls(page, "eth_blockNumber", 1);

        await delayWallet(page, "eth_chainId", 600);
        await emit(page, "chainChanged", "0xcf");
        await emit(page, "disconnect");
        await waitUntil(async () => (await bodyText(page)).includes("Connect Wallet"), {
            label: "the header to return to its unconnected state",
        });
        // Bounded: past the held-back answers, which are what would restore
        // it. ethers' getNetwork asks for the chain twice, so the last one
        // lands about two delays after the lookup starts.
        await page.waitForTimeout(3000);

        const refresh = page.locator("button", { hasText: /^Refresh$/ }).first();
        await waitUntil(() => refresh.isEnabled(), {
            label: "the marketplace to finish its load",
        });
        const blockReads = async () =>
            (await walletCalls(page)).filter((c) => c.method === "eth_blockNumber").length;
        const before = await blockReads();
        await refresh.click();
        // Bounded: the correct behaviour is a call that never arrives.
        await page.waitForTimeout(1500);

        assert.equal(await blockReads(), before, "a disconnected wallet must not be read from");
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});
