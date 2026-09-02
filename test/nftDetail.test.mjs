import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { chromium } from "playwright";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
    waitUntil,
    waitForHydration,
    CONDITION_TIMEOUT,
    nftPageAnswers,
    answerCall,
    appConfig as config,
} from "./helpers/browserHarness.mjs";

/**
 * The NFT detail page against the real production build.
 *
 * Token metadata is hostile input, so these run the page with metadata a
 * malicious mint can actually store, and with media sources that are simply
 * gone. The page must stay up, state what is on chain and what is not, and say
 * so instead of holding a skeleton that is indistinguishable from loading.
 */
// Just above the latest contract creation block, so the page's historical log
// scan is one range instead of ~125 against a routed-offline provider.
const BLOCK = "0x222e00";

const METADATA_UNAVAILABLE = "Metadata unavailable";

const onChain = (metadata) =>
    "data:application/json;base64," +
    Buffer.from(JSON.stringify(metadata)).toString("base64");

/**
 * What each caller is here to read, as a condition.
 *
 * A CSS selector for an element the route must mount, or a regular expression
 * over the same `document.body.innerText` the assertions below read.
 */
async function waitForReady(page, until) {
    if (until instanceof RegExp) {
        await waitUntil(
            async () =>
                until.test(await page.evaluate(() => document.body.innerText)),
            { label: `body text matching ${until}` }
        );
        return;
    }
    await page.locator(until).first().waitFor({ timeout: CONDITION_TIMEOUT });
}

async function openPage(browser, origin, { route, answers, onCall, until }) {
    const page = await browser.newPage();
    await routeOffline(page, origin, {
        rpc: {
            eth_blockNumber: BLOCK,
            eth_call: (body) => {
                onCall?.(body);
                return answers
                    ? answerCall(answers, body)
                    : `0x${"0".repeat(64)}`;
            },
        },
    });
    await installMockWallet(page, {
        chain: { answers: answers ?? {}, blockNumber: BLOCK },
    });
    await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    if (until) await waitForReady(page, until);
    return page;
}

test(
    "hostile metadata cannot blank the NFT page",
    { skip: !hasBuild },
    async () => {
        // `name` as an object is rendered as a React child today. React throws,
        // and with no error boundary anywhere in this repo the whole tree unmounts.
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const answers = nftPageAnswers({
                nftType: "text",
                id: 1,
                uri: onChain({
                    name: { evil: 1 },
                    description: "x",
                    text_uri: "data:text/plain,hi",
                }),
            });
            const page = await openPage(browser, origin, {
                route: "/nft/?type=text&id=1",
                answers,
                until: new RegExp(METADATA_UNAVAILABLE),
            });
            const text = await page.evaluate(() => document.body.innerText);
            assert.ok(
                text.includes("VinuNFT"),
                "the page must still be mounted"
            );
            assert.ok(
                text.includes(METADATA_UNAVAILABLE),
                `page must state the metadata is unusable, got: ${text.slice(
                    0,
                    400
                )}`
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "on-chain supply survives metadata that cannot be fetched",
    { skip: !hasBuild },
    async () => {
        // The gateway allowlist refuses this host outright, so no request is made.
        // Supply was read from the contract and is still true; hiding it because a
        // separate, external read failed reports the chain inaccurately.
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const answers = nftPageAnswers({
                nftType: "text",
                id: 1,
                uri: "https://evil.example/meta.json",
                totalSupply: 100,
            });
            const page = await openPage(browser, origin, {
                route: "/nft/?type=text&id=1",
                answers,
                // The metadata fetch is refused, so the on-chain figure is the
                // last thing this page has to say.
                until: /Edition size:\s*100/,
            });
            const text = await page.evaluate(() => document.body.innerText);
            assert.match(
                text,
                /Edition size:\s*100/,
                "on-chain supply must still render"
            );
            assert.ok(
                text.includes(METADATA_UNAVAILABLE),
                "the failure must be stated, not implied"
            );
            assert.equal(
                await page.locator(".standard-error-body").count(),
                0,
                "a media failure must not take over the page-level error banner"
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "unreachable image media gets its own state and a retry",
    { skip: !hasBuild },
    async () => {
        // routeOffline aborts every non-origin request, so both IPFS gateways are
        // down by construction. Today this renders <img src={undefined}>: no
        // skeleton, no message, nothing.
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const answers = nftPageAnswers({
                nftType: "image",
                id: 1,
                uri: onChain({
                    name: "Pic",
                    description: "d",
                    image: "ipfs://QmGone",
                }),
            });
            const page = await openPage(browser, origin, {
                route: "/nft/?type=image&id=1",
                answers,
                until: ".nft-media-unavailable",
            });
            assert.equal(
                await page.locator(".nft-media-unavailable").count(),
                1,
                "the failing media needs a terminal state of its own"
            );
            assert.equal(
                await page.locator("button.nft-media-retry").count(),
                1,
                "an unavailable media state must offer a retry"
            );
            assert.equal(
                await page.locator(".standard-error-body").count(),
                0,
                "a media failure must not take over the page-level error banner"
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "provenance names the contract, the token and where metadata lives",
    { skip: !hasBuild },
    async () => {
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const answers = nftPageAnswers({
                nftType: "text",
                id: 1,
                uri: onChain({
                    name: "Nutshell",
                    description: "d",
                    text_uri: "data:text/plain,hi",
                }),
            });
            const page = await openPage(browser, origin, {
                route: "/nft/?type=text&id=1",
                answers,
                until: /Metadata\s*On-chain/i,
            });
            const text = await page.evaluate(() => document.body.innerText);
            assert.match(
                text,
                /Token ID\s*1/,
                "the token id must be stated, not only implied by the URL"
            );
            assert.match(
                text,
                /Metadata\s*On-chain/i,
                "the page must say where the metadata lives"
            );
            const explorer = `${config.blockExplorer.url}/address/${config.contractAddresses.v1.text}`;
            assert.equal(
                await page.locator(`a[href="${explorer}"]`).count(),
                1,
                "the contract must be linked on the explorer"
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "a malformed route issues no contract read",
    { skip: !hasBuild },
    async () => {
        // parseInt("5abc") is 5, so the page currently reads a token the URL never
        // named, and an unknown type builds a contract at address undefined.
        const uriSelector = ethers.utils.id("uri(uint256)").slice(0, 10);
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            for (const route of [
                "/nft/?type=text&id=5abc",
                "/nft/?type=bogus&id=1",
            ]) {
                const calls = [];
                const page = await openPage(browser, origin, {
                    route,
                    onCall: (body) =>
                        calls.push(String(body?.params?.[0]?.data ?? "")),
                    // The refusal is rendered from the parsed route, so once
                    // it is on screen the page has decided what to read.
                    until: ".nft-unsupported-route",
                });
                assert.ok(
                    !calls.some((data) => data.startsWith(uriSelector)),
                    `${route} must not read a token: ${calls.join(",")}`
                );
                await page.close();
            }
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "an unsupported route says so instead of silently redirecting",
    { skip: !hasBuild },
    async () => {
        // `marketplace` is a configured address but not a collection, and -1 is
        // not a token. Bouncing to the home page tells the visitor nothing about
        // why the link they followed did not work.
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            for (const route of [
                "/nft/?type=marketplace&id=1",
                "/nft/?type=text&id=-1",
            ]) {
                const page = await openPage(browser, origin, {
                    route,
                    until: ".nft-unsupported-route",
                });
                assert.equal(
                    await page.locator(".nft-unsupported-route").count(),
                    1,
                    `${route} must state that it names no token`
                );
                assert.ok(
                    page.url().includes("/nft/"),
                    `${route} must not be redirected away`
                );
                await page.close();
            }

            // The mirror case: a fix that rejects everything must not pass.
            const page = await openPage(browser, origin, {
                route: "/nft/?type=text&id=1",
                answers: nftPageAnswers({
                    nftType: "text",
                    id: 1,
                    uri: onChain({
                        name: "Nutshell",
                        description: "d",
                        text_uri: "data:text/plain,hi",
                    }),
                }),
                // The token has to have rendered before "no refusal here"
                // means anything.
                until: /Token ID\s*1/,
            });
            assert.equal(
                await page.locator(".nft-unsupported-route").count(),
                0,
                "a valid route must still render the token"
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "user content is framed as unendorsed and its links stay inert",
    { skip: !hasBuild },
    async () => {
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const answers = nftPageAnswers({
                nftType: "text",
                id: 1,
                uri: onChain({
                    name: "Nutshell",
                    description: "d",
                    text_uri:
                        "data:text/html,<a href='https://evil.example'>click</a>",
                }),
            });
            const page = await openPage(browser, origin, {
                route: "/nft/?type=text&id=1",
                answers,
                until: "iframe",
            });
            // The sanitised content is put into the frame after it mounts, and
            // the frame sizes itself off that content.
            await waitUntil(
                async () =>
                    /click/.test(
                        await page
                            .locator("iframe")
                            .first()
                            .evaluate(
                                (el) => el.contentDocument?.body?.innerText ?? ""
                            )
                    ),
                { label: "the sanitised content in the viewer" }
            );
            // The built page shipped `sandbox` with no value, which React drops
            // for a string attribute, so no sandbox reached the browser at all.
            // The value has to be exactly this: `allow-same-origin` alone keeps
            // scripts, forms, popups, downloads and top-level navigation off
            // while letting the viewer measure its own height through the
            // frame's DOM (a fully empty sandbox renders the content at 0px).
            // Any added token — allow-scripts above all — fails here.
            assert.equal(
                await page.locator("iframe").first().getAttribute("sandbox"),
                "allow-same-origin",
                "the viewer sandbox must be present and grant nothing else"
            );
            // The sandbox and the viewer's own height measurement are in
            // tension: the viewer sizes itself by reading the frame's DOM, so a
            // fully empty sandbox would render every text NFT at 0px while every
            // other assertion in this suite still passed. Pin the height here,
            // or "tighten the sandbox" becomes an invisible outage.
            const frame = await page
                .locator("iframe")
                .first()
                .evaluate((el) => ({
                    clientHeight: el.clientHeight,
                    body: el.contentDocument?.body?.innerText ?? "",
                }));
            assert.ok(
                frame.clientHeight > 0,
                "the viewer must still size itself to its content"
            );
            assert.match(
                frame.body,
                /click/,
                "the sanitised content must actually be in the frame"
            );

            const text = await page.evaluate(() => document.body.innerText);
            assert.match(
                text,
                /not reviewed or endorsed/i,
                "the page must say the content is the creator's, not ours"
            );
            assert.match(
                text,
                /links inside it are disabled/i,
                "an inert link must be explained, not left to look broken"
            );
            assert.match(
                text,
                /not identity-verified/i,
                "an author address proves control of a key, not who someone is"
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "a late answer for the token the user left cannot overwrite the token they are on",
    { skip: !hasBuild },
    async () => {
        // Client-side navigation, not a second goto: a goto reloads the
        // document, the component remounts, and no stale response can survive
        // — a test written that way passes whether the bug is present or not.
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            // One table: every entry is keyed by the encoded token id, so the
            // two tokens' answers cannot collide.
            const answers = {
                ...nftPageAnswers({ id: 1, totalSupply: 100 }),
                ...nftPageAnswers({ id: 2, totalSupply: 10 }),
            };
            const nft = config.contractAddresses.v1.text.toLowerCase();
            const totalSupplySig = new ethers.utils.Interface([
                "function totalSupply(uint256) view returns (uint256)",
            ]).getSighash("totalSupply");

            // The stale read, counted at both ends: a navigation that happens
            // before it is issued proves nothing, and an assertion made before
            // its answer lands cannot see the overwrite it is looking for.
            const stale = { issued: 0, answered: 0 };
            const page = await browser.newPage();
            await routeOffline(page, origin, {
                rpc: {
                    eth_blockNumber: BLOCK,
                    eth_call: async (body) => {
                        const call = body?.params?.[0] ?? {};
                        const to = String(call.to ?? "").toLowerCase();
                        const data = String(call.data ?? "").toLowerCase();
                        if (
                            to === nft &&
                            data.startsWith(totalSupplySig) &&
                            Number("0x" + data.slice(10, 74)) === 1
                        ) {
                            // The slow read the user navigated away from: it
                            // lands well after token 2 has already answered.
                            stale.issued += 1;
                            await new Promise((r) => setTimeout(r, 1500));
                            stale.answered += 1;
                        }
                        return answerCall(answers, body, []);
                    },
                },
            });
            await installMockWallet(page, {
                chain: { answers, blockNumber: BLOCK },
            });
            await page.goto(`${origin}/nft/?type=text&id=1`, {
                waitUntil: "domcontentloaded",
            });
            await waitForHydration(page);
            await waitUntil(() => stale.issued > 0, {
                label: "the slow token-1 read to be in flight",
            });

            assert.equal(
                await page.evaluate(() => typeof window.___navigate),
                "function",
                "this test depends on Gatsby's client-side navigation"
            );
            await page.evaluate(() =>
                window.___navigate("/nft?type=text&id=2")
            );
            await waitUntil(() => stale.answered > 0, {
                label: "the abandoned read to answer",
            });
            const bodyText = async () =>
                (await page.evaluate(() => document.body.innerText)).replace(
                    /\s+/g,
                    " "
                );
            await waitUntil(async () => /Edition size: 10\b/.test(await bodyText()), {
                label: "token 2 to render",
            });
            // Bounded on purpose: the stale answer has left the harness, but
            // the render it could corrupt is a task or two later in the page
            // and nothing on screen marks a value that must never appear.
            // Measured rather than guessed: widening this to 4000 changed
            // nothing at load average ~45, so the overwrite does not land late,
            // it does not land.
            await page.waitForTimeout(300);

            const text = await bodyText();
            assert.match(text, /Edition size: 10\b/);
            assert.doesNotMatch(text, /Edition size: 100\b/);
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "the Owners and History tabs are reachable and operable from the keyboard",
    { skip: !hasBuild },
    async () => {
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        try {
            const answers = nftPageAnswers({ id: 1 });
            const page = await openPage(browser, origin, {
                route: "/nft/?type=text&id=1",
                answers,
                until: ".tabs li",
            });

            const reached = [];
            for (let i = 0; i < 60; i++) {
                await page.keyboard.press("Tab");
                reached.push(
                    await page.evaluate(() =>
                        (document.activeElement?.textContent ?? "").trim()
                    )
                );
                if (reached.at(-1) === "History") break;
            }
            assert.ok(
                reached.includes("Owners"),
                "Owners tab is not focusable"
            );
            assert.ok(
                reached.includes("History"),
                "History tab is not focusable"
            );

            // Focus is on History; the tab must respond to a key, not only a click.
            await page.keyboard.press("Enter");
            const historyIsActive = () =>
                page.evaluate(() =>
                    document
                        .querySelector(".tabs li:nth-child(2)")
                        ?.className.includes("is-active")
                );
            await waitUntil(historyIsActive, {
                label: "the History tab to become active",
            });
            assert.equal(
                await historyIsActive(),
                true,
                "Enter did not switch to the History tab"
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);

test(
    "media is not fetched until the creator policy decision is known",
    { skip: !hasBuild },
    async () => {
        // The content policy can hide a token because of WHO created it, and
        // the creator is an `authorOf` read. Until that read lands the page
        // does not know whether this media may be shown, so it must not pull
        // the bytes: "hidden" means not fetched, not fetched and then hidden.
        // The metadata here is on-chain, so nothing but the policy stands
        // between the page load and the media request.
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        const AUTHOR_OF = ethers.utils
            .id("authorOf(uint256)")
            .slice(0, 10)
            .toLowerCase();
        const CID = "QmRaceCanary";
        let releaseAuthor;
        const authorHeld = new Promise((resolve) => {
            releaseAuthor = resolve;
        });
        try {
            const answers = nftPageAnswers({
                nftType: "image",
                id: 1,
                uri: onChain({
                    name: "Canary",
                    description: "d",
                    image: `ipfs://${CID}`,
                }),
            });
            const mediaRequests = [];
            const page = await browser.newPage();
            page.on("request", (request) => {
                if (request.url().includes(CID)) {
                    mediaRequests.push(request.url());
                }
            });
            await routeOffline(page, origin, {
                rpc: {
                    eth_blockNumber: BLOCK,
                    eth_call: async (body) => {
                        const data = String(
                            body?.params?.[0]?.data ?? ""
                        ).toLowerCase();
                        if (data.startsWith(AUTHOR_OF)) {
                            await authorHeld;
                        }
                        return answerCall(answers, body);
                    },
                },
            });
            await installMockWallet(page, {
                chain: { answers, blockNumber: BLOCK },
            });
            await page.goto(`${origin}/nft/?type=image&id=1`, {
                waitUntil: "domcontentloaded",
            });
            await waitForHydration(page);
            // The metadata is in hand: everything the media fetch needs except
            // permission to run.
            await waitUntil(
                async () =>
                    /Canary/.test(
                        await page.evaluate(() => document.body.innerText)
                    ),
                { label: "the token's on-chain metadata" }
            );

            // Generous next to the milliseconds an unguarded fetch takes: on
            // the unfixed page the request is already recorded by now.
            const fetchedEarly = await waitUntil(
                () => mediaRequests.length > 0,
                { timeout: 3000 }
            ).catch(() => false);
            assert.equal(
                fetchedEarly,
                false,
                `no media may be fetched while the creator is unknown, got: ${mediaRequests}`
            );

            releaseAuthor();
            // Anti-vacuity: the same request must happen once the decision is
            // known, or this test would pass against a page that never loads
            // media at all.
            await waitUntil(() => mediaRequests.length > 0, {
                label: "the media request, once the creator is known",
            });
        } finally {
            releaseAuthor();
            await browser.close();
            server.close();
        }
    }
);

test(
    "a creator read that fails leaves the media unfetched, not unguarded",
    { skip: !hasBuild },
    async () => {
        // The creator is the input an address-scoped entry is matched against.
        // A failed `authorOf` is an UNKNOWN creator, not an absent one, so
        // treating it as "no entry names them" would let any transient RPC
        // failure fetch and paint the very media an entry exists to suppress —
        // a suppression control that a flaky node switches off. The page fails
        // closed and offers its Retry instead.
        const { server, origin } = await startStaticServer();
        const browser = await chromium.launch();
        const AUTHOR_OF = ethers.utils
            .id("authorOf(uint256)")
            .slice(0, 10)
            .toLowerCase();
        const CID = "QmUncheckedCreator";
        try {
            const answers = nftPageAnswers({
                nftType: "image",
                id: 1,
                uri: onChain({
                    name: "Unchecked",
                    description: "d",
                    image: `ipfs://${CID}`,
                }),
            });
            const mediaRequests = [];
            const page = await browser.newPage();
            page.on("request", (request) => {
                if (request.url().includes(CID)) {
                    mediaRequests.push(request.url());
                }
            });
            await routeOffline(page, origin, {
                rpc: {
                    eth_blockNumber: BLOCK,
                    eth_call: (body) => {
                        const data = String(
                            body?.params?.[0]?.data ?? ""
                        ).toLowerCase();
                        // Empty return data: the shape a reverting or
                        // half-synced node actually answers with.
                        return data.startsWith(AUTHOR_OF)
                            ? "0x"
                            : answerCall(answers, body);
                    },
                },
            });
            await installMockWallet(page, {
                chain: { answers, blockNumber: BLOCK },
            });
            await page.goto(`${origin}/nft/?type=image&id=1`, {
                waitUntil: "domcontentloaded",
            });
            await waitForHydration(page);
            // Anti-vacuity: the page must reach a terminal state, or "no media
            // was fetched" would only mean "the page never got that far". The
            // metadata is on chain, so it lands whatever `authorOf` does.
            await waitUntil(
                async () =>
                    /Unchecked/.test(
                        await page.evaluate(() => document.body.innerText)
                    ),
                { label: "the token's on-chain metadata" }
            );
            await page
                .locator(".nft-media-retry")
                .first()
                .waitFor({ timeout: CONDITION_TIMEOUT });

            assert.deepEqual(
                mediaRequests,
                [],
                `no media may be fetched when the creator could not be read, got: ${mediaRequests}`
            );
        } finally {
            await browser.close();
            server.close();
        }
    }
);
