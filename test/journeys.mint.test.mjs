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
    chainReceipt,
    appConfig as config,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

// See journeys.buy.test.mjs.
const BLOCK = "0x222e00";
const RECEIPT_BLOCK = "0x222dff";

// 200000 gas at 1 gwei is 0.0002 VC, which is what the page must print.
const GAS_LIMIT = "0x30d40";
const GAS_PRICE = "0x3b9aca00";

const textIface = new ethers.utils.Interface([
    "function mint(string,string,string,uint256,uint96,address,bytes)",
]);

// The smallest thing Chromium will accept as an image, so the preview under
// test is a real object URL rather than a broken one.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
);

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

async function openMint({ chain = {}, reject = [], uploads = null } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();

    await installMockWallet(page, {
        reject,
        chain: {
            answers: {},
            blockNumber: BLOCK,
            gasLimit: GAS_LIMIT,
            gasPrice: GAS_PRICE,
            receipt: chainReceipt({ blockNumber: RECEIPT_BLOCK }),
            ...chain,
        },
    });
    await routeOffline(page, origin, { rpc: { eth_blockNumber: BLOCK } });
    if (uploads) {
        // config.ipfsUploadEndpoint is same-origin, so routeOffline would let
        // it through to the static server and 404. Registered last, because
        // Playwright matches the most recently added handler first.
        await page.route("**/api/upload-ipfs", (route) => {
            uploads.count += 1;
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ IpfsHash: `Qm${uploads.count}` }),
            });
        });
    }
    await page.goto(`${origin}/mint/`, { waitUntil: "domcontentloaded" });
    await connectWallet(page);
    return { page, context };
}

const signatures = async (page) =>
    (await walletCalls(page)).filter((c) => c.method === "personal_sign");

const sends = async (page) =>
    (await walletCalls(page)).filter((c) => c.method === "eth_sendTransaction");

const mintButton = (page) => page.locator("button", { hasText: /Mint|Upload/ });

const FEE_LINE = new RegExp(
    `Estimated network fee: 0\\.0002 ${config.nativeCurrency.symbol}`
);

/**
 * The quote is computed from the whole form, so its arrival is the one signal
 * that every field the creator typed has reached the mint the button submits.
 */
const waitForQuote = (page) =>
    waitUntil(
        async () => FEE_LINE.test(await page.textContent("main, body")),
        { label: "the fee quote" }
    );

async function fillCommon(page, { title, description, editionSize = "1" }) {
    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="description"]').fill(description);
    await page.locator('input[name="editionSize"]').fill(editionSize);
}

test(
    "a text mint is quoted before the creator commits, and never guessed",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMint();
        try {
            await page.locator("select#content").selectOption("text/plain");
            await fillCommon(page, {
                title: "Quoted",
                description: "A text NFT",
            });
            await page.locator("textarea.textarea").fill("Hello world");
            await waitForQuote(page);

            assert.match(await page.textContent("main, body"), FEE_LINE);

            // A node that will not quote is not a fee of zero: the line has to
            // disappear rather than claim the mint is free.
            await page.evaluate(() => {
                window.__chainState.estimateGasError = "execution reverted";
            });
            await page.locator("textarea.textarea").fill("Hello world!");
            // A transition, not an absence poll: the line was on screen a
            // moment ago and has to come off once the re-quote fails.
            await waitUntil(
                async () =>
                    !/Estimated network fee/.test(
                        await page.textContent("main, body")
                    ),
                { label: "the fee line to be withdrawn" }
            );

            assert.doesNotMatch(
                await page.textContent("main, body"),
                /Estimated network fee/
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a text mint submits exactly what the form describes and opens the new token",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMint({
            chain: {
                receipt: chainReceipt({
                    blockNumber: RECEIPT_BLOCK,
                    transferSingle: { nft: "text", id: 7, amount: 3 },
                }),
            },
        });
        try {
            await page.locator("select#content").selectOption("text/plain");
            await fillCommon(page, {
                title: "Hello",
                description: "A test",
                editionSize: "3",
            });
            await page.locator('input[name="royaltyPercentage"]').fill("10");
            await page.locator("textarea.textarea").fill("Hello world");
            await waitForQuote(page);
            await mintButton(page).click();
            await page.waitForURL(/\/nft\/?\?type=text&id=7/);

            const decoded = textIface.decodeFunctionData(
                "mint",
                (await sends(page))[0].params[0].data
            );
            assert.equal(decoded[0], "data:text/plain,Hello%20world");
            assert.equal(decoded[1], "Hello");
            assert.equal(decoded[2], "A test");
            assert.equal(decoded[3].toNumber(), 3);
            assert.equal(
                decoded[4].toNumber(),
                1000,
                "10% is stored as basis points"
            );
            assert.equal(
                decoded[5],
                TEST_ACCOUNT,
                "royalties go to the connected account by default"
            );
            // mintTextNft passes the number 0 for the trailing bytes field,
            // which ethers hexlifies to a single zero byte.
            assert.equal(decoded[6], "0x00");
            assert.match(
                page.url(),
                /\/nft\/?\?type=text&id=7/,
                "the receipt's new token id is where the creator lands"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a declined mint says why, and leaves the button ready to try again",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMint({
            reject: ["eth_sendTransaction"],
        });
        try {
            await page.locator("select#content").selectOption("text/plain");
            await fillCommon(page, { title: "Declined", description: "Nope" });
            await page.locator("textarea.textarea").fill("Hello");
            await waitForQuote(page);
            await mintButton(page).click();
            await waitForTextMatch(
                page.locator(".standard-error-body"),
                /User rejected the request/
            );

            const banner = await page.textContent(".standard-error-body");
            assert.match(banner, /User rejected the request/);
            assert.doesNotMatch(
                banner,
                /No transaction receipt/,
                "the banner must not contradict the toast beside it"
            );
            assert.equal(await mintButton(page).textContent(), "Mint");
            assert.equal(await mintButton(page).isDisabled(), false);
        } finally {
            await context.close();
        }
    }
);

test(
    "a chosen image is shown back before anything is signed",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMint();
        try {
            await page.locator("input.file-input").setInputFiles({
                name: "art.png",
                mimeType: "image/png",
                buffer: PNG,
            });
            await page.locator('img[src^="blob:"]').first().waitFor();

            assert.ok(
                await page.locator('img[src^="blob:"]').first().isVisible(),
                "the creator must see what they picked"
            );
            assert.deepEqual(
                await signatures(page),
                [],
                "previewing costs no signature"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "an image over the upload limit is refused before a signature is spent",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openMint();
        try {
            await page.locator("input.file-input").setInputFiles({
                name: "huge.png",
                mimeType: "image/png",
                buffer: Buffer.alloc(config.maxIpfsUploadBytes + 1),
            });
            await waitForTextMatch(
                page.locator(".standard-error-body"),
                /larger than the 10 MiB upload limit/
            );

            assert.match(
                await page.textContent(".standard-error-body"),
                /larger than the 10 MiB upload limit/
            );
            assert.equal(
                await page.locator('img[src^="blob:"]').count(),
                0,
                "a refused file must not be previewed either"
            );
            assert.deepEqual(
                await signatures(page),
                [],
                "the endpoint's own size check runs after signMessage"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a mint that fails does not re-upload and re-sign what is already pinned",
    { skip: !hasBuild },
    async () => {
        const uploads = { count: 0 };
        const { page, context } = await openMint({
            uploads,
            chain: {
                receipt: chainReceipt({
                    blockNumber: RECEIPT_BLOCK,
                    transferSingle: { nft: "image", id: 4, amount: 1 },
                }),
            },
        });
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

            await fillCommon(page, { title: "Art", description: "An image" });
            await page.locator("input.file-input").setInputFiles({
                name: "art.png",
                mimeType: "image/png",
                buffer: PNG,
            });
            await page.locator('img[src^="blob:"]').first().waitFor();

            await mintButton(page).click();
            // The refusal banner is the end of the first attempt: both uploads
            // and both payload signatures happen before the wallet is asked.
            // (The decline is raised by the stub above, which never reaches
            // the recorder, so the wallet call log cannot be the anchor here.)
            await waitForTextMatch(
                page.locator(".standard-error-body"),
                /User rejected the request/
            );
            assert.equal(uploads.count, 2, "image and metadata, once each");
            assert.equal((await signatures(page)).length, 2);

            await mintButton(page).click();
            await page.waitForURL(/\/nft\/?\?type=image&id=4/);
            assert.match(page.url(), /\/nft\/?\?type=image&id=4/);

            assert.equal(
                uploads.count,
                2,
                "the retry must reuse the CIDs already pinned"
            );
            assert.equal(
                (await signatures(page)).length,
                2,
                "and must not spend a second signature on either payload"
            );
        } finally {
            await context.close();
        }
    }
);
