import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { chromium } from "playwright";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
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
const SETTLE_MS = 4000;

const METADATA_UNAVAILABLE = "Metadata unavailable";

const onChain = (metadata) =>
    "data:application/json;base64," +
    Buffer.from(JSON.stringify(metadata)).toString("base64");

async function openPage(browser, origin, { route, answers, onCall }) {
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
    await page.waitForTimeout(SETTLE_MS);
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
                const page = await openPage(browser, origin, { route });
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
            });
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
