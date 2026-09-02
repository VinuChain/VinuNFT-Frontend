import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { ethers } from "ethers";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
    connectWallet,
    walletCalls,
    waitUntil,
    waitForTextMatch,
    waitForWalletCalls,
    chainAnswers,
    chainMisses,
    chainReceipt,
    answerCall,
    nftPageAnswers,
    appConfig as config,
    setChainAnswers,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

// Just above the latest contract creation block, so every historical log scan
// is one range instead of ~125. The wallet, the HTTP provider and the receipt
// must all agree, or tx.wait(1) never reaches one confirmation.
const BLOCK = "0x222e00";
const RECEIPT_BLOCK = "0x222dff";

const NFT = config.contractAddresses.v1.text;
const MARKETPLACE = config.contractAddresses.v1.marketplace;
const WVC = config.tokens.wvc;
const marketplaceIface = new ethers.utils.Interface([
    "function buyToken(address,uint256,uint256,uint256,uint256) payable",
]);
const erc20Iface = new ethers.utils.Interface([
    "function approve(address,uint256)",
]);

// Buy controls only render for listings the connected account does not own
// (Listings.js splits on seller === walletAddress), so this fixture's seller
// must not be TEST_ACCOUNT.
const SELLER = ethers.utils.getAddress(
    "0x00000000000000000000000000000000000d1ea5"
);
const PRICE = "3.125";
const PRICE_RAW = ethers.utils.parseUnits(PRICE, WVC.decimals);
const PLENTY = ethers.utils.parseUnits("1000", WVC.decimals).toString();

const buyFixture = (overrides = {}) =>
    nftPageAnswers({
        listings: [
            { paymentToken: "wvc", price: PRICE, seller: SELLER, amount: 4 },
        ],
        balances: { [SELLER]: 10, [TEST_ACCOUNT]: 0 },
        approvals: { [SELLER]: true },
        ...overrides,
    });

const paymentBalance = (raw) =>
    chainAnswers([
        { to: "wvc", fn: "balanceOf", args: [TEST_ACCOUNT], returns: [raw] },
    ]);

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

async function openNft(answers, chainOverrides = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await installMockWallet(page, {
        chain: {
            answers,
            blockNumber: BLOCK,
            receipt: chainReceipt({ blockNumber: RECEIPT_BLOCK }),
            ...chainOverrides,
        },
    });
    await routeOffline(page, origin, {
        rpc: {
            eth_blockNumber: BLOCK,
            eth_call: (body) => answerCall(answers, body),
        },
    });
    await page.goto(`${origin}/nft/?type=text&id=1`, {
        waitUntil: "domcontentloaded",
    });
    await connectWallet(page);
    return { page, context, errors };
}

const sends = async (page) =>
    (await walletCalls(page)).filter((c) => c.method === "eth_sendTransaction");

/** The hash the mock wallet handed back for the last broadcast transaction. */
const sentHash = (page) =>
    page.evaluate(() => Object.keys(window.__chainState.sent).pop());

const openBuyModal = async (page) => {
    await page.locator("button", { hasText: /^Buy$/ }).first().click();
    await page.locator(".modal-card").waitFor();
    await footerButton(page).waitFor({ state: "visible" });
};

// The footer offers Approve until the allowance read comes back, so a caller
// that clicks on sight can sign an approval it never meant to.
const clickBuyFooter = async (page) => {
    await waitForTextMatch(footerButton(page), /^Buy$/);
    await footerButton(page).click();
};

const footerButton = (page) => page.locator(".modal-card-foot button").first();

test(
    "the buy footer offers Approve until the allowance covers the total, then Buy",
    { skip: !hasBuild },
    async () => {
        const answers = {
            ...buyFixture(),
            ...paymentBalance(PLENTY),
        };
        const { page, context, errors } = await openNft(answers);
        try {
            await openBuyModal(page);
            const approveLabel = new RegExp(`Approve ${PRICE} ${WVC.symbol}`);
            await waitForTextMatch(footerButton(page), approveLabel);
            assert.match(
                await footerButton(page).textContent(),
                approveLabel,
                "a zero allowance must offer approval, not a purchase"
            );

            // The approval the user is about to give really does change the
            // chain, so the table changes with it.
            await setChainAnswers(
                page,
                chainAnswers([
                    { to: "wvc", fn: "allowance", returns: [PLENTY] },
                ])
            );
            await footerButton(page).click();
            await waitForWalletCalls(page, "eth_sendTransaction", 1);
            // The footer re-reads the allowance once the approval mines, and
            // that re-read is the last thing this test asserts on.
            await waitForTextMatch(footerButton(page), /^Buy$/);

            const approvals = (await sends(page)).filter(
                (c) => c.params[0].to.toLowerCase() === WVC.address.toLowerCase()
            );
            assert.equal(approvals.length, 1, "one approval, to the token");
            const decoded = erc20Iface.decodeFunctionData(
                "approve",
                approvals[0].params[0].data
            );
            assert.equal(decoded[0], MARKETPLACE);
            assert.equal(decoded[1].toString(), PRICE_RAW.toString());

            // The modal stays open across the approval, so this is the same
            // footer re-rendering off the re-read allowance.
            assert.match(
                await footerButton(page).textContent(),
                /^Buy$/,
                "once the allowance covers the total the footer must buy"
            );
            assert.deepEqual(await chainMisses(page), []);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    }
);

test(
    "a balance one wei short of the total cannot buy",
    { skip: !hasBuild },
    async () => {
        // The shortfall an 18-decimal token can hide: parseFloat collapses
        // "3.124999999999999999" and "3.125" onto the same double.
        const answers = {
            ...buyFixture({ allowance: PLENTY }),
            ...paymentBalance(PRICE_RAW.sub(1).toString()),
        };
        const { page, context } = await openNft(answers);
        try {
            await openBuyModal(page);
            await waitForTextMatch(
                page.locator(".modal-card-body"),
                /Insufficient balance/
            );

            assert.match(
                await page.locator(".modal-card-body").textContent(),
                /Insufficient balance/,
                "the shortfall must be named"
            );
            assert.equal(
                await footerButton(page).isDisabled(),
                true,
                "an unaffordable purchase must not be submittable"
            );
            assert.deepEqual(await sends(page), []);
        } finally {
            await context.close();
        }
    }
);

test(
    "a listing whose price changed under the buyer is refused before signing",
    { skip: !hasBuild },
    async () => {
        // What the buyer saw and what the chain now holds, at once: `listings`
        // still answers the rendered price, `getListing` the new one.
        const answers = {
            ...buyFixture({ allowance: PLENTY }),
            ...paymentBalance(PLENTY),
            ...chainAnswers([
                {
                    to: "marketplace",
                    fn: "getListing",
                    args: [NFT, 1, 0],
                    returns: [
                        [
                            WVC.address,
                            ethers.utils.parseUnits("4.0", WVC.decimals),
                            SELLER,
                            4,
                        ],
                    ],
                },
            ]),
        };
        const { page, context } = await openNft(answers);
        try {
            await openBuyModal(page);
            await clickBuyFooter(page);
            await waitForTextMatch(
                page.locator(".standard-error-body"),
                /price of this listing changed/i
            );

            assert.match(
                await page.locator(".standard-error-body").textContent(),
                /price of this listing changed/i
            );
            assert.deepEqual(
                await sends(page),
                [],
                "nothing may be signed against a stale price"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a seller who withdrew the marketplace's approval cannot be bought from",
    { skip: !hasBuild },
    async () => {
        // Price and quantity are untouched here, so only the authority check
        // can produce this rejection.
        const answers = {
            ...buyFixture({
                allowance: PLENTY,
                approvals: { [SELLER]: false },
            }),
            ...paymentBalance(PLENTY),
        };
        const { page, context } = await openNft(answers);
        try {
            await openBuyModal(page);
            await clickBuyFooter(page);
            await waitForTextMatch(
                page.locator(".standard-error-body"),
                /withdrawn the marketplace's permission/i
            );

            assert.match(
                await page.locator(".standard-error-body").textContent(),
                /withdrawn the marketplace's permission/i
            );
            assert.deepEqual(await sends(page), []);
        } finally {
            await context.close();
        }
    }
);

test(
    "a fresh listing is bought at the price on screen and the receipt links to the explorer",
    { skip: !hasBuild },
    async () => {
        const answers = {
            ...buyFixture({ allowance: PLENTY }),
            ...paymentBalance(PLENTY),
        };
        const { page, context, errors } = await openNft(answers);
        try {
            await openBuyModal(page);
            await page.locator(".modal-card-body input[type=number]").fill("2");
            // The lot total is recomputed from the typed quantity, so it is
            // what says the form holds 2 rather than the default 1.
            await waitForTextMatch(
                page.locator(".modal-card-body"),
                /Total:\s*6\.25\s*WVC/
            );
            await clickBuyFooter(page);
            await waitForWalletCalls(page, "eth_sendTransaction", 1);

            const purchases = (await sends(page)).filter(
                (c) =>
                    c.params[0].to.toLowerCase() === MARKETPLACE.toLowerCase()
            );
            assert.equal(purchases.length, 1);
            const decoded = marketplaceIface.decodeFunctionData(
                "buyToken",
                purchases[0].params[0].data
            );
            assert.equal(decoded[0], NFT);
            assert.equal(decoded[1].toNumber(), 1);
            assert.equal(decoded[2].toNumber(), 0, "the listing bought");
            assert.equal(decoded[3].toNumber(), 2, "the quantity typed");
            assert.equal(
                decoded[4].toString(),
                PRICE_RAW.toString(),
                "the unit price the buyer was shown, in the token's own units"
            );

            const hash = await sentHash(page);
            const toast = page.locator(".Toastify__toast").first();
            await waitForTextMatch(toast, /mined/i);
            assert.match(await toast.textContent(), /mined/i);
            assert.equal(
                await toast.locator("a").first().getAttribute("href"),
                `${config.blockExplorer.url}/tx/${hash}`
            );
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    }
);
