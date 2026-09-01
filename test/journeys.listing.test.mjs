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
    chainMisses,
    chainReceipt,
    answerCall,
    nftPageAnswers,
    appConfig as config,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

// See journeys.buy.test.mjs: one log range instead of ~125, and a receipt the
// current block can confirm.
const BLOCK = "0x222e00";
const RECEIPT_BLOCK = "0x222dff";

const NFT = config.contractAddresses.v1.text;
const marketplaceIface = new ethers.utils.Interface([
    "function listToken(address,uint256,address,uint256,uint256)",
    "function editListing(address,uint256,uint256,uint256,int256,int256)",
    "function delistToken(address,uint256,uint256)",
]);

const LISTED_PRICE = "1.5";

// Edit and Delist only render for a listing the connected account owns
// (Listings.js), so this fixture's seller is TEST_ACCOUNT — the mirror image of
// the buy fixture.
const listingFixture = (overrides = {}) =>
    nftPageAnswers({
        listings: [
            {
                paymentToken: "usdt",
                price: LISTED_PRICE,
                seller: TEST_ACCOUNT,
                amount: 3,
            },
        ],
        balances: { [TEST_ACCOUNT]: 5 },
        approvals: { [TEST_ACCOUNT]: true },
        ...overrides,
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

async function openNft(answers) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await installMockWallet(page, {
        chain: {
            answers,
            blockNumber: BLOCK,
            receipt: chainReceipt({ blockNumber: RECEIPT_BLOCK }),
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
    await page.waitForTimeout(900);
    return { page, context, errors };
}

const sends = async (page) =>
    (await walletCalls(page)).filter((c) => c.method === "eth_sendTransaction");

const footerButton = (page) => page.locator(".modal-card-foot button").first();

async function openModal(page, label) {
    await page.locator("button", { hasText: label }).first().click();
    await page.locator(".modal-card").waitFor();
    await page.waitForTimeout(400);
}

async function fillListing(page, { paymentToken, price, amount = "1" }) {
    await page
        .locator(".modal-card-body select")
        .selectOption(paymentToken);
    await page.locator('.modal-card-body input[name="amount"]').fill(amount);
    await page.locator('.modal-card-body input[name="price"]').fill(price);
    await page.waitForTimeout(400);
}

test(
    "an unapproved seller is asked to approve the marketplace, not to list",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft(
            listingFixture({ approvals: { [TEST_ACCOUNT]: false } })
        );
        try {
            await openModal(page, /^List$/);
            assert.match(
                await footerButton(page).textContent(),
                /Approve Marketplace/
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "an approved seller can list, and the price is submitted in the token's own decimals",
    { skip: !hasBuild },
    async () => {
        // The pair to the test above: with the same page and only the stubbed
        // approval flipped, the footer must offer the listing itself.
        const { page, context, errors } = await openNft(listingFixture());
        try {
            await openModal(page, /^List$/);
            assert.match(await footerButton(page).textContent(), /^List$/);

            await fillListing(page, {
                paymentToken: "usdt",
                price: "2.5",
                amount: "2",
            });
            await footerButton(page).click();
            await page.waitForTimeout(2500);

            const listings = await sends(page);
            assert.equal(listings.length, 1);
            const decoded = marketplaceIface.decodeFunctionData(
                "listToken",
                listings[0].params[0].data
            );
            assert.equal(decoded[0], NFT);
            assert.equal(decoded[1].toNumber(), 1);
            assert.equal(decoded[2], config.tokens.usdt.address);
            assert.equal(
                decoded[3].toString(),
                "2500000",
                "2.5 USDT is 2500000 base units, not 2.5e18"
            );
            assert.equal(decoded[4].toNumber(), 2);

            assert.match(
                await page.locator(".Toastify__toast").first().textContent(),
                /mined/i
            );
            assert.deepEqual(await chainMisses(page), []);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    }
);

test(
    "the same typed price on an 18-decimal token submits a different amount",
    { skip: !hasBuild },
    async () => {
        // Without this pair, a listToken assertion could be satisfied by any
        // fixed encoding of "2.5".
        const { page, context } = await openNft(listingFixture());
        try {
            await openModal(page, /^List$/);
            await fillListing(page, { paymentToken: "wvc", price: "2.5" });
            await footerButton(page).click();
            await page.waitForTimeout(2500);

            const decoded = marketplaceIface.decodeFunctionData(
                "listToken",
                (await sends(page))[0].params[0].data
            );
            assert.equal(decoded[2], config.tokens.wvc.address);
            assert.equal(decoded[3].toString(), "2500000000000000000");
        } finally {
            await context.close();
        }
    }
);

test(
    "a price finer than the payment token can hold is refused before signing",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft(listingFixture());
        try {
            await openModal(page, /^List$/);
            await fillListing(page, {
                paymentToken: "usdt",
                price: "0.0000001",
            });

            assert.match(
                await page.locator(".modal-card-body").textContent(),
                /at most 6 decimal places/i
            );
            assert.equal(await footerButton(page).isDisabled(), true);

            // The same seven-decimal price is perfectly listable in WVC, so the
            // refusal is about the token, not about the digits.
            await fillListing(page, {
                paymentToken: "wvc",
                price: "0.0000001",
            });
            assert.doesNotMatch(
                await page.locator(".modal-card-body").textContent(),
                /at most 6 decimal places/i
            );
            assert.equal(await footerButton(page).isDisabled(), false);
            assert.deepEqual(await sends(page), []);
        } finally {
            await context.close();
        }
    }
);

test(
    "editing only the price leaves the listed quantity untouched",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft(listingFixture());
        try {
            await openModal(page, /^Edit$/);
            await page
                .locator(".modal-card-body label", { hasText: "Edit Price" })
                .locator("input[type=checkbox]")
                .check();
            await page
                .locator('.modal-card-body input[name="price"]')
                .fill("4.25");
            await page.waitForTimeout(400);
            await footerButton(page).click();
            await page.waitForTimeout(2500);

            const decoded = marketplaceIface.decodeFunctionData(
                "editListing",
                (await sends(page))[0].params[0].data
            );
            assert.equal(decoded[0], NFT);
            assert.equal(decoded[1].toNumber(), 1);
            assert.equal(decoded[2].toNumber(), 0, "the listing edited");
            assert.equal(decoded[3].toString(), "4250000", "the new USDT price");
            assert.equal(decoded[4].toNumber(), -1, "quantity left alone");
            assert.equal(
                decoded[5].toNumber(),
                -1,
                "and therefore no expected-quantity guard"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "delisting submits delistToken for that listing",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft(listingFixture());
        try {
            await page.locator("button", { hasText: /^Delist$/ }).click();
            await page.waitForTimeout(2500);

            const decoded = marketplaceIface.decodeFunctionData(
                "delistToken",
                (await sends(page))[0].params[0].data
            );
            assert.deepEqual(
                [decoded[0], decoded[1].toNumber(), decoded[2].toNumber()],
                [NFT, 1, 0]
            );
            assert.match(
                await page.locator(".Toastify__toast").first().textContent(),
                /mined/i
            );
        } finally {
            await context.close();
        }
    }
);
