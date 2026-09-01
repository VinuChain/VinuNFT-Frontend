import assert from "node:assert/strict";
import test from "node:test";
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
 * A text NFT keeps its body on chain, delivered as a `data:` URI through two
 * hops: uri(id) returns data:application/json, whose text_uri is a second
 * data: URI holding the body.
 *
 * Both hops went through fetch(), which CSP governs via connect-src. The
 * shipped policy does not list data:, so both were refused and the page held a
 * permanent skeleton where the writing should be. These assertions run against
 * the real production build, with its real CSP header, so they fail if that
 * policy or the decode path regresses.
 */
// Just above the latest contract creation block, so the page's historical log
// scan is one range instead of ~125 against a routed-offline provider.
const BLOCK = "0x222e00";

const body = "VinuChain in a Nutshell — ☑ café";
const textUri = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`;
const metadataUri = `data:application/json;base64,${Buffer.from(
    JSON.stringify({ name: "Nutshell", description: "on chain", text_uri: textUri })
).toString("base64")}`;

test("a text NFT renders its on-chain body against the shipped CSP", { skip: !hasBuild }, async () => {
    const { server, origin } = await startStaticServer();
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const cspErrors = [];
    page.on("console", (m) => {
        const t = m.text();
        if (!/Content Security Policy|Refused to connect/i.test(t)) return;
        // The ENS lookup against Alchemy mainnet is refused by the same policy.
        // It is a separate defect and must not mask this one.
        if (/alchemyapi\.io|frame-ancestors/i.test(t)) return;
        cspErrors.push(t);
    });

    try {
        const answers = nftPageAnswers({ nftType: "text", id: 1, uri: metadataUri });
        await routeOffline(page, origin, {
            rpc: {
                eth_blockNumber: BLOCK,
                eth_call: (b) => answerCall(answers, b),
            },
        });
        await installMockWallet(page, { chain: { answers, blockNumber: BLOCK } });
        await page.goto(`${origin}/nft/?type=text&id=1`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(4000);

        const pre = page.locator("pre.nft-plain");
        assert.equal(await pre.count(), 1, "the text body element must render");
        assert.equal((await pre.textContent()).trim(), body);

        // The decode must not go near the network at all.
        assert.deepEqual(cspErrors, [], "no CSP refusal may occur loading a text NFT");

        // connect-src must NOT have been widened to make this work.
        const csp = await page.evaluate(
            () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ""
        );
        if (csp) {
            const connect = csp.match(/connect-src[^;]*/)?.[0] ?? "";
            assert.ok(!/\bdata:/.test(connect), "connect-src must not need data:");
        }
    } finally {
        await browser.close();
        server.close();
    }
});
