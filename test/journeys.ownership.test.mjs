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
    return { page, context, errors };
}

const sends = async (page) =>
    (await walletCalls(page)).filter((c) => c.method === "eth_sendTransaction");

const footerButton = (page) => page.locator(".modal-card-foot button").first();
const modalBody = (page) => page.locator(".modal-card-body");

async function openModal(page, label) {
    await page.locator("button", { hasText: label }).first().click();
    // The footer is the control every caller acts on, and it is the last part
    // of the card to mount.
    await footerButton(page).waitFor({ state: "visible" });
}

test(
    "the owner block separates what is owned from what is free to move",
    { skip: !hasBuild },
    async () => {
        const { page, context, errors } = await openNft();
        try {
            // The two figures are read from the chain after the wallet
            // connects, so the later of them is what says the block is done.
            const bodyText = async () =>
                (await page.textContent("body")).replace(/\s+/g, " ");
            await waitUntil(async () => /Not listed: 2/.test(await bodyText()), {
                label: "the owner block",
            });
            const text = await bodyText();
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

            // Bounded on purpose: a quantity inside the free balance renders
            // nothing at all, so there is no arrival to wait for and polling
            // for the absent warning would pass before the form re-rendered.
            await amount.fill("2");
            await page.waitForTimeout(300);
            assert.equal(
                await page.locator(".notification.is-warning").count(),
                0,
                "the two free tokens carry no warning"
            );

            await amount.fill("3");
            const warning = page.locator(".notification.is-warning");
            await warning.waitFor({ state: "visible" });
            assert.match(
                await warning.textContent(),
                /tied to existing listings/i
            );

            await amount.fill("6");
            const danger = page.locator(".notification.is-danger");
            await waitForTextMatch(
                danger,
                /Cannot gift more tokens than you own \(5\)/
            );
            assert.match(
                await danger.textContent(),
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
            await footerButton(page).click();
            await waitForWalletCalls(page, "eth_sendTransaction", 1);

            const decoded = nftIface.decodeFunctionData(
                "safeTransferFrom",
                (await sends(page))[0].params[0].data
            );
            assert.equal(decoded[0], TEST_ACCOUNT, "from the owner");
            assert.equal(decoded[1], RECIPIENT);
            assert.equal(decoded[2].toNumber(), 1);
            assert.equal(decoded[3].toNumber(), 2);
            assert.equal(decoded[4], "0x");
            const toast = page.locator(".Toastify__toast").first();
            await waitForTextMatch(toast, /mined/i);
            assert.match(await toast.textContent(), /mined/i);
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
            await footerButton(page).click();
            await waitForWalletCalls(page, "eth_sendTransaction", 1);

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
            const help = page.locator("p.help.is-danger");
            await waitForTextMatch(help, /valid Ethereum name or address/);
            assert.match(
                await help.textContent(),
                /valid Ethereum name or address/
            );
            assert.equal(await footerButton(page).isDisabled(), true);

            // A blank recipient is the same mistake, and used to be accepted
            // and then dereferenced as `to.includes(".eth")` on undefined.
            // Clearing the field restores the form default, so isDirty goes
            // false and the button is live again — the submit itself has to
            // refuse.
            await to.fill("");
            // The message is already on screen from "0x123", so it is the
            // button coming back to life that says the empty field has been
            // revalidated.
            await waitUntil(async () => !(await footerButton(page).isDisabled()), {
                label: "the submit button to go live on the restored default",
            });
            assert.match(
                await help.textContent(),
                /valid Ethereum name or address/
            );
            await footerButton(page).click();
            // Bounded on purpose: a submit that refuses renders nothing and
            // navigates nowhere, so there is no arrival that proves the
            // handler ran and declined.
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
            await footerButton(page).click();
            const error = page.locator(".standard-error-body");
            await waitForTextMatch(error, /Could not resolve ENS name/);

            assert.match(
                await error.textContent(),
                /Could not resolve ENS name/
            );
            assert.deepEqual(await sends(page), []);
        } finally {
            await context.close();
        }
    }
);
