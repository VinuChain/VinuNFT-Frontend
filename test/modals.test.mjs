import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { ethers } from "ethers";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
    connectWallet,
    chainReceipt,
    answerCall,
    nftPageAnswers,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

/**
 * The seven modals, as a keyboard and a screen reader meet them, and at the
 * width most owners will meet them.
 *
 * A modal is the only place in this product where a signature is authorised, so
 * "the dialog is announced, focus goes in, stays in, and comes back" is not
 * decoration. Driven through the real openers rather than by injecting markup:
 * a shell that is never mounted proves nothing.
 */
const BLOCK = "0x222e00";
const PHONE = { width: 375, height: 667 };

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

const ownerAnswers = () =>
    nftPageAnswers({
        balances: { [TEST_ACCOUNT]: 5 },
        approvals: { [TEST_ACCOUNT]: true },
    });

// Five owned, three of them on the account's own listing: enough state for
// List, Buy, Edit and Edit Royalty to all be offered on the one page.
const listedAnswers = () =>
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

// A stranger's listing: Listings.js splits on seller === walletAddress, so
// nobody is offered Buy on their own listing.
const OTHER_SELLER = ethers.utils.getAddress(
    "0x00000000000000000000000000000000000d1ea5"
);
const sellerAnswers = () =>
    nftPageAnswers({
        listings: [
            {
                paymentToken: "wvc",
                price: "3.125",
                seller: OTHER_SELLER,
                amount: 4,
            },
        ],
        balances: { [OTHER_SELLER]: 10, [TEST_ACCOUNT]: 0 },
        approvals: { [OTHER_SELLER]: true },
    });

/**
 * Every modal opens the same way: click the one control that offers it.
 * Returns that control, because focus return is asserted against it.
 */
const byButton = (label) => async (page) => {
    const trigger = page.locator("button", { hasText: label }).first();
    await trigger.click();
    return trigger;
};

const MODALS = [
    {
        label: "Mint confirmation",
        route: "/mint/",
        answers: () => ({}),
        open: byButton(/^Mint$/),
    },
    {
        label: "Gift",
        route: "/nft/?type=text&id=1",
        answers: ownerAnswers,
        open: byButton(/^Gift$/),
    },
    {
        label: "Burn",
        route: "/nft/?type=text&id=1",
        answers: ownerAnswers,
        open: byButton(/^Burn$/),
    },
    {
        label: "List",
        route: "/nft/?type=text&id=1",
        answers: listedAnswers,
        open: byButton(/^List$/),
    },
    {
        label: "Buy",
        route: "/nft/?type=text&id=1",
        // A listing by someone else: nobody is offered their own listing.
        answers: sellerAnswers,
        open: byButton(/^Buy$/),
    },
    {
        label: "Edit listing",
        route: "/nft/?type=text&id=1",
        answers: listedAnswers,
        open: byButton(/^Edit$/),
    },
];

async function openRoute({ route, answers }, viewport) {
    const context = await browser.newContext(
        viewport ? { viewport, hasTouch: true, isMobile: true } : {}
    );
    const page = await context.newPage();
    const table = answers();
    await installMockWallet(page, {
        chain: {
            answers: table,
            blockNumber: BLOCK,
            receipt: chainReceipt({ blockNumber: BLOCK }),
        },
    });
    await routeOffline(page, origin, {
        rpc: {
            eth_blockNumber: BLOCK,
            eth_call: (body) => answerCall(table, body),
        },
    });
    await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
    await connectWallet(page);
    return { page, context };
}

const activeCard = (page) => page.locator(".modal.is-active .modal-card");

/** True while the focused element is inside the open dialog. */
const focusIsInDialog = (page) =>
    page.evaluate(() => {
        const card = document.querySelector(".modal.is-active .modal-card");
        return Boolean(
            card &&
                document.activeElement &&
                card.contains(document.activeElement)
        );
    });

for (const modal of MODALS) {
    test(
        `${modal.label}: the dialog is announced and takes focus`,
        { skip: !hasBuild },
        async () => {
            const { page, context } = await openRoute(modal);
            try {
                await modal.open(page);
                // Anti-vacuity: every assertion below is trivially satisfiable on a
                // page with no modal, so prove one was actually mounted first.
                await activeCard(page).waitFor({ state: "visible" });

                assert.equal(
                    await activeCard(page).getAttribute("role"),
                    "dialog"
                );
                assert.equal(
                    await activeCard(page).getAttribute("aria-modal"),
                    "true"
                );

                const labelledBy = await activeCard(page).getAttribute(
                    "aria-labelledby"
                );
                assert.ok(
                    labelledBy,
                    "the dialog must name itself from its own title"
                );
                assert.ok(
                    (
                        await page.locator(`[id="${labelledBy}"]`).textContent()
                    )?.trim(),
                    "aria-labelledby must point at non-empty text"
                );

                assert.ok(
                    await focusIsInDialog(page),
                    "focus must move into the dialog"
                );

                // Every amount, address and price field lives in a dialog, and
                // ValidatedInput used to render its <label> as a bare sibling,
                // so a screen reader announced "edit, blank" for all of them.
                const unnamed = await page.$$eval(
                    ".modal.is-active input:not([type=hidden]), .modal.is-active select, .modal.is-active textarea",
                    (nodes) =>
                        nodes
                            .filter((node) => {
                                const name =
                                    node.labels?.[0]?.textContent?.trim() ||
                                    node.getAttribute("aria-label") ||
                                    node.getAttribute("title");
                                return !name;
                            })
                            .map((node) => node.outerHTML.slice(0, 120))
                );
                assert.deepEqual(
                    unnamed,
                    [],
                    "dialog fields a screen reader cannot name"
                );
            } finally {
                await context.close();
            }
        }
    );

    test(
        `${modal.label}: focus is trapped, Escape closes, focus returns`,
        { skip: !hasBuild },
        async () => {
            const { page, context } = await openRoute(modal);
            try {
                const trigger = await modal.open(page);
                await activeCard(page).waitFor({ state: "visible" });

                for (let i = 0; i < 12; i++) {
                    await page.keyboard.press("Tab");
                    assert.ok(
                        await focusIsInDialog(page),
                        `focus escaped the dialog after ${i + 1} Tab presses`
                    );
                }
                for (let i = 0; i < 3; i++) {
                    await page.keyboard.press("Shift+Tab");
                    assert.ok(
                        await focusIsInDialog(page),
                        "focus escaped the dialog backwards"
                    );
                }

                await page.keyboard.press("Escape");
                // The dialog was open a moment ago, so this is a transition to
                // wait for rather than an absence to poll.
                await page
                    .locator(".modal.is-active")
                    .waitFor({ state: "detached" });
                assert.equal(
                    await page.locator(".modal.is-active").count(),
                    0,
                    "Escape must close the dialog"
                );

                // Returning focus to the opener is what makes a dialog usable
                // without a pointer: otherwise the next Tab starts from the top.
                assert.ok(
                    await trigger.evaluate(
                        (node) => node === document.activeElement
                    ),
                    "focus must return to the control that opened the dialog"
                );
            } finally {
                await context.close();
            }
        }
    );

    test(
        `${modal.label}: closes from the keyboard via its own close control`,
        { skip: !hasBuild },
        async () => {
            const { page, context } = await openRoute(modal);
            try {
                await modal.open(page);
                await activeCard(page).waitFor({ state: "visible" });

                // Clicking the backdrop is a pointer-only dismissal, so without a
                // close control a keyboard user cannot leave the dialog at all.
                const close = page.getByRole("button", { name: /close/i });
                assert.equal(
                    await close.count(),
                    1,
                    "the dialog needs one close control"
                );
                await close.press("Enter");
                await page
                    .locator(".modal.is-active")
                    .waitFor({ state: "detached" });
                assert.equal(await page.locator(".modal.is-active").count(), 0);
            } finally {
                await context.close();
            }
        }
    );

    test(
        `${modal.label}: fits a 375px phone`,
        { skip: !hasBuild },
        async () => {
            const { page, context } = await openRoute(modal, PHONE);
            try {
                await modal.open(page);
                await activeCard(page).waitFor({ state: "visible" });

                const overflow = await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth -
                        document.documentElement.clientWidth
                );
                assert.ok(
                    overflow <= 2,
                    `the open dialog overflows by ${overflow}px`
                );

                const small = await page.$$eval(
                    ".modal.is-active button, .modal.is-active a[href], .modal.is-active input, .modal.is-active select",
                    (nodes) =>
                        nodes
                            .filter((node) => {
                                const cs = getComputedStyle(node);
                                if (
                                    cs.display === "none" ||
                                    cs.visibility === "hidden"
                                )
                                    return false;
                                const r = node.getBoundingClientRect();
                                if (r.width === 0 || r.height === 0)
                                    return false;
                                return r.width < 24 || r.height < 24;
                            })
                            .map((node) => {
                                const r = node.getBoundingClientRect();
                                return `${node.tagName} '${(
                                    node.textContent ?? ""
                                )
                                    .trim()
                                    .slice(0, 24)}' ${Math.round(
                                    r.width
                                )}x${Math.round(r.height)}`;
                            })
                );
                assert.deepEqual(
                    [...new Set(small)],
                    [],
                    "dialog targets under 24x24"
                );
            } finally {
                await context.close();
            }
        }
    );
}
