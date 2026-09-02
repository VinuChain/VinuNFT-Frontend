import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { ethers } from "ethers";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
    connectWallet,
    waitUntil,
    waitForTextMatch,
    chainAnswers,
    chainReceipt,
    answerCall,
    nftPageAnswers,
    appConfig as config,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

// See journeys.buy.test.mjs.
const BLOCK = "0x222e00";
const RECEIPT_BLOCK = "0x222dff";

const WVC = config.tokens.wvc;
const SELLER = ethers.utils.getAddress(
    "0x00000000000000000000000000000000000d1ea5"
);
const PLENTY = ethers.utils.parseUnits("1000", WVC.decimals).toString();

// A purchase is the shortest path to a real transaction: allowance and balance
// are already satisfied, so clicking Buy signs immediately.
const readyToBuy = () => ({
    ...nftPageAnswers({
        listings: [
            { paymentToken: "wvc", price: "3.125", seller: SELLER, amount: 4 },
        ],
        balances: { [SELLER]: 10, [TEST_ACCOUNT]: 0 },
        approvals: { [SELLER]: true },
        allowance: PLENTY,
    }),
    ...chainAnswers([
        { to: "wvc", fn: "balanceOf", args: [TEST_ACCOUNT], returns: [PLENTY] },
    ]),
});

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

async function openNft({ chain = {}, reject = [], rpc = {} } = {}) {
    const answers = readyToBuy();
    const context = await browser.newContext();
    const page = await context.newPage();

    await installMockWallet(page, {
        reject,
        chain: {
            answers,
            blockNumber: BLOCK,
            receipt: chainReceipt({ blockNumber: RECEIPT_BLOCK }),
            ...chain,
        },
    });
    await routeOffline(page, origin, {
        rpc: {
            eth_blockNumber: BLOCK,
            eth_call: (body) => answerCall(answers, body),
            ...rpc,
        },
    });
    await page.goto(`${origin}/nft/?type=text&id=1`, {
        waitUntil: "domcontentloaded",
    });
    await connectWallet(page);
    return { page, context };
}

const toasts = (page) => page.locator(".Toastify__toast");
const sentHash = (page) =>
    page.evaluate(() => Object.keys(window.__chainState.sent).pop());

async function clickBuy(page) {
    await page.locator("button", { hasText: /^Buy$/ }).first().click();
    await page.locator(".modal-card").waitFor();
    // The footer reads Approve until the allowance has been re-read, so
    // clicking on sight can sign the wrong transaction.
    const footer = page.locator(".modal-card-foot button").first();
    await waitForTextMatch(footer, /^Buy$/);
    await footer.click();
}

test(
    "a signature the user declines is reported as a failure, with nothing to look up",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft({
            reject: ["eth_sendTransaction"],
        });
        try {
            await clickBuy(page);

            const toast = toasts(page).first();
            await waitForTextMatch(toast, /failed/i);
            assert.match(await toast.textContent(), /failed/i);
            assert.match(await toast.textContent(), /User rejected/i);
            assert.equal(
                await toast.locator("a").count(),
                0,
                "a transaction that was never broadcast has no explorer page"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "while the wallet still holds the request the transaction is only pending",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft();
        try {
            // Web3Provider resolves `.request` off the same object on every
            // call, so this holds the transaction in the state where the
            // MetaMask prompt is still on screen.
            await page.evaluate(() => {
                const original = window.ethereum.request.bind(window.ethereum);
                window.ethereum.request = async (args) => {
                    if (args.method === "eth_sendTransaction") {
                        await new Promise((r) => setTimeout(r, 2500));
                    }
                    return original(args);
                };
            });

            await clickBuy(page);

            const toast = toasts(page).first();
            await waitForTextMatch(toast, /Waiting for approval/i);
            assert.match(await toast.textContent(), /Waiting for approval/i);
            assert.equal(
                await toast.locator("a").count(),
                0,
                "there is no hash to link to before the wallet answers"
            );

            await waitForTextMatch(toast, /mined/i);
            assert.match(await toast.textContent(), /mined/i);
        } finally {
            await context.close();
        }
    }
);

// The one assertion that proves the toast reads the receipt rather than the
// mere existence of one: nothing changes between these two runs but `status`.
for (const [status, outcome, notOutcome] of [
    ["0x1", /mined/i, /failed/i],
    ["0x0", /failed/i, /mined/i],
]) {
    test(
        `a receipt with status ${status} is reported as ${outcome.source}, still linking to the explorer`,
        { skip: !hasBuild },
        async () => {
            const { page, context } = await openNft({
                chain: {
                    receipt: chainReceipt({
                        blockNumber: RECEIPT_BLOCK,
                        status,
                    }),
                },
            });
            try {
                await clickBuy(page);

                const toast = toasts(page).first();
                await waitForTextMatch(toast, outcome);
                assert.match(await toast.textContent(), outcome);
                assert.doesNotMatch(await toast.textContent(), notOutcome);
                assert.equal(
                    await toast.locator("a").first().getAttribute("href"),
                    `${config.blockExplorer.url}/tx/${await sentHash(page)}`,
                    "a reverted transaction is still worth looking up"
                );
            } finally {
                await context.close();
            }
        }
    );
}

test(
    "a transaction still in flight when the page reloads is recovered and resolved",
    { skip: !hasBuild },
    async () => {
        // Held pending, so the reload happens exactly where the outcome is
        // still unknown and the hash is the only way back to it.
        let mined = false;
        const { page, context } = await openNft({
            chain: { receipt: null },
            rpc: {
                eth_getTransactionReceipt: (body) =>
                    mined
                        ? {
                              ...chainReceipt({ blockNumber: RECEIPT_BLOCK }),
                              transactionHash: body.params[0],
                          }
                        : null,
            },
        });
        try {
            await clickBuy(page);
            // The link appears only once the wallet has answered with a hash.
            await toasts(page).first().locator("a").waitFor();
            const hash = await sentHash(page);
            const explorerLink = `${config.blockExplorer.url}/tx/${hash}`;
            assert.equal(
                await toasts(page).first().locator("a").getAttribute("href"),
                explorerLink
            );

            await page.reload({ waitUntil: "domcontentloaded" });

            const restored = toasts(page).first();
            await waitForTextMatch(restored, /approved/i);
            assert.equal(
                await restored.locator("a").getAttribute("href"),
                explorerLink,
                "the reloaded page must still be able to look the transaction up"
            );
            assert.match(await restored.textContent(), /approved/i);

            mined = true;
            await page.reload({ waitUntil: "domcontentloaded" });

            const resolved = toasts(page).first();
            await waitForTextMatch(resolved, /mined/i);
            assert.match(
                await resolved.textContent(),
                /mined/i,
                "the outcome must be re-resolved from the chain, not guessed"
            );
            assert.equal(
                await resolved.locator("a").getAttribute("href"),
                explorerLink
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a purchase declined once can be signed on the second attempt",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft();
        try {
            await page.evaluate(() => {
                const original = window.ethereum.request.bind(window.ethereum);
                let declined = false;
                window.ethereum.request = async (args) => {
                    if (args.method === "eth_sendTransaction" && !declined) {
                        declined = true;
                        const error = new Error("User rejected the request.");
                        error.code = 4001;
                        throw error;
                    }
                    return original(args);
                };
            });

            await clickBuy(page);
            await waitForTextMatch(toasts(page).first(), /failed/i);
            assert.match(await toasts(page).first().textContent(), /failed/i);

            await clickBuy(page);
            // Both the second toast and its mined outcome have to have landed
            // before "only one transaction reached the chain" means anything.
            await toasts(page).nth(1).waitFor();
            await waitUntil(
                async () =>
                    (await toasts(page).allTextContents()).some((t) =>
                        /mined/i.test(t)
                    ),
                { label: "the retry to be mined" }
            );

            assert.equal(
                await toasts(page).count(),
                2,
                "the retry gets its own notification, not the first one reused"
            );
            const texts = await toasts(page).allTextContents();
            assert.equal(texts.filter((t) => /mined/i.test(t)).length, 1);
            assert.equal(texts.filter((t) => /failed/i.test(t)).length, 1);
            assert.equal(
                await page.evaluate(
                    () => Object.keys(window.__chainState.sent).length
                ),
                1,
                "only the accepted attempt reached the chain"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a transaction toast can be dismissed from the keyboard",
    { skip: !hasBuild },
    async () => {
        // The close control was a <p> wrapping a <span>, both with onClick: a
        // screen reader announced nothing there and Tab never reached it, so
        // the only way to clear a toast was a mouse or its 30s timeout.
        const { page, context } = await openNft({
            reject: ["eth_sendTransaction"],
        });
        try {
            await clickBuy(page);
            await waitForTextMatch(toasts(page).first(), /failed/i);
            assert.equal(await toasts(page).count(), 1);

            const dismiss = page.getByRole("button", {
                name: /dismiss notification/i,
            });
            assert.equal(await dismiss.count(), 1);
            await dismiss.press("Enter");
            await toasts(page).first().waitFor({ state: "detached" });
            assert.equal(await toasts(page).count(), 0);
        } finally {
            await context.close();
        }
    }
);
