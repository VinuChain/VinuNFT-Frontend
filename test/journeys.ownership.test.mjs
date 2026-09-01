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

// See journeys.buy.test.mjs.
const BLOCK = "0x222e00";
const RECEIPT_BLOCK = "0x222dff";

const NFT = config.contractAddresses.v1.text;
const nftIface = new ethers.utils.Interface([
    "function safeTransferFrom(address,address,uint256,uint256,bytes)",
    "function burn(address,uint256,uint256)",
]);

const RECIPIENT = ethers.utils.getAddress(
    "0x000000000000000000000000000000000000f00d"
);

// Five owned, three of them tied up in the account's own listing, so
// userAvailableAmount() is 2 and the two figures on screen must differ.
const ownerFixture = () =>
    nftPageAnswers({
        listings: [
            {
                paymentToken: "usdt",
                price: "1.5",
                seller: TEST_ACCOUNT,
                amount: 3,
            },
        ],
        balances: { [TEST_ACCOUNT]: 5 },
        approvals: { [TEST_ACCOUNT]: true },
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

async function openNft() {
    const answers = ownerFixture();
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
const modalBody = (page) => page.locator(".modal-card-body");

async function openModal(page, label) {
    await page.locator("button", { hasText: label }).first().click();
    await page.locator(".modal-card").waitFor();
    await page.waitForTimeout(400);
}

test(
    "the owner block separates what is owned from what is free to move",
    { skip: !hasBuild },
    async () => {
        const { page, context, errors } = await openNft();
        try {
            const text = (await page.textContent("body")).replace(/\s+/g, " ");
            assert.match(text, /Owned: 5/);
            assert.match(text, /Not listed: 2/);
            assert.deepEqual(await chainMisses(page), []);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    }
);

test(
    "both modals say what cannot be undone",
    { skip: !hasBuild },
    async () => {
        // Scoped to the body: "Burn" is in the header, so a page-wide match
        // would let a loose regex pass on the title alone.
        const { page, context } = await openNft();
        try {
            await openModal(page, /^Burn$/);
            assert.match(
                await modalBody(page).textContent(),
                /permanently|cannot be recovered/i
            );
            // The card covers the background, so close it the way the
            // handler is actually wired rather than through a real click.
            await page.locator(".modal-background").dispatchEvent("click");

            await openModal(page, /^Gift$/);
            assert.match(await modalBody(page).textContent(), /final/i);
        } finally {
            await context.close();
        }
    }
);

test(
    "moving more than is free warns that listings become unfulfillable",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft();
        try {
            await openModal(page, /^Gift$/);
            const amount = modalBody(page).locator('input[name="amount"]');

            await amount.fill("2");
            await page.waitForTimeout(300);
            assert.equal(
                await page.locator(".notification.is-warning").count(),
                0,
                "the two free tokens carry no warning"
            );

            await amount.fill("3");
            await page.waitForTimeout(300);
            assert.match(
                await page.locator(".notification.is-warning").textContent(),
                /tied to existing listings/i
            );

            await amount.fill("6");
            await page.waitForTimeout(300);
            assert.match(
                await page.locator(".notification.is-danger").textContent(),
                /Cannot gift more tokens than you own \(5\)/
            );
            assert.equal(await footerButton(page).isDisabled(), true);
            assert.deepEqual(await sends(page), []);
        } finally {
            await context.close();
        }
    }
);

test(
    "a gift submits safeTransferFrom for exactly the typed quantity",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft();
        try {
            await openModal(page, /^Gift$/);
            await modalBody(page).locator('input[name="amount"]').fill("2");
            await modalBody(page).locator('input[name="to"]').fill(RECIPIENT);
            await page.waitForTimeout(400);
            await footerButton(page).click();
            await page.waitForTimeout(2500);

            const decoded = nftIface.decodeFunctionData(
                "safeTransferFrom",
                (await sends(page))[0].params[0].data
            );
            assert.equal(decoded[0], TEST_ACCOUNT, "from the owner");
            assert.equal(decoded[1], RECIPIENT);
            assert.equal(decoded[2].toNumber(), 1);
            assert.equal(decoded[3].toNumber(), 2);
            assert.equal(decoded[4], "0x");
            assert.match(
                await page.locator(".Toastify__toast").first().textContent(),
                /mined/i
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a burn destroys exactly the typed quantity from the owner's balance",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openNft();
        try {
            await openModal(page, /^Burn$/);
            await modalBody(page).locator('input[name="amount"]').fill("1");
            await page.waitForTimeout(400);
            await footerButton(page).click();
            await page.waitForTimeout(2500);

            const decoded = nftIface.decodeFunctionData(
                "burn",
                (await sends(page))[0].params[0].data
            );
            assert.equal(decoded[0], TEST_ACCOUNT);
            assert.equal(decoded[1].toNumber(), 1);
            assert.equal(decoded[2].toNumber(), 1);
        } finally {
            await context.close();
        }
    }
);

test(
    "a recipient that is neither an address nor an ENS name cannot be gifted",
    { skip: !hasBuild },
    async () => {
        const { page, context, errors } = await openNft();
        try {
            await openModal(page, /^Gift$/);
            const to = modalBody(page).locator('input[name="to"]');

            await to.fill("0x123");
            await page.waitForTimeout(400);
            assert.match(
                await page.locator("p.help.is-danger").textContent(),
                /valid Ethereum name or address/
            );
            assert.equal(await footerButton(page).isDisabled(), true);

            // A blank recipient is the same mistake, and used to be accepted
            // and then dereferenced as `to.includes(".eth")` on undefined.
            // Clearing the field restores the form default, so isDirty goes
            // false and the button is live again — the submit itself has to
            // refuse.
            await to.fill("");
            await page.waitForTimeout(400);
            assert.match(
                await page.locator("p.help.is-danger").textContent(),
                /valid Ethereum name or address/
            );
            await footerButton(page).click();
            await page.waitForTimeout(1000);

            assert.deepEqual(await sends(page), []);
            assert.deepEqual(errors, [], "no recipient may crash the handler");
        } finally {
            await context.close();
        }
    }
);

test(
    "an ENS name that cannot be resolved is reported as such",
    { skip: !hasBuild },
    async () => {
        // The ENS provider is off-origin, so routeOffline aborts it: the same
        // outcome as a name nobody registered.
        const { page, context } = await openNft();
        try {
            await openModal(page, /^Gift$/);
            await modalBody(page).locator('input[name="to"]').fill("nobody.eth");
            await page.waitForTimeout(400);
            await footerButton(page).click();
            await page.waitForTimeout(2000);

            assert.match(
                await page.locator(".standard-error-body").textContent(),
                /Could not resolve ENS name/
            );
            assert.deepEqual(await sends(page), []);
        } finally {
            await context.close();
        }
    }
);
