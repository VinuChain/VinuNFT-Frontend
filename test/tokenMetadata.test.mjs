import assert from "node:assert/strict";
import test from "node:test";

const nftInfo = await import("../src/common/nftInfo.js");
const { fetchTokenMetadata, getTokenContent } = nftInfo.default || nftInfo;

const realFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Token metadata is attacker-controlled: `mint` stores whatever string it is
 * given, and the result is parsed and rendered in a stranger's browser. Every
 * fixture below is a shape a hostile token can actually put on chain. */
const onChain = (metadata) =>
    "data:application/json;base64," +
    Buffer.from(JSON.stringify(metadata)).toString("base64");

test("well-formed on-chain metadata keeps its fields and names its source", async () => {
    const result = await fetchTokenMetadata(
        onChain({
            name: "Nutshell",
            description: "on chain",
            text_uri: "data:text/plain,hi",
        })
    );
    assert.equal(result.metadata.name, "Nutshell");
    assert.equal(result.metadata.text_uri, "data:text/plain,hi");
    assert.equal(result.source, "on-chain");
    assert.match(result.uri, /^data:application\/json/);
});

test("metadata fetched from a gateway is labelled external, not on-chain", async () => {
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({ name: "Remote", image: "ipfs://QmPic" }),
            {
                status: 200,
                headers: { "content-type": "application/json" },
            }
        );
    const result = await fetchTokenMetadata("ipfs://QmMeta");
    assert.equal(result.source, "external");
    assert.equal(result.uri, "ipfs://QmMeta");
    assert.equal(result.metadata.name, "Remote");
});

test("a nested object where a string belongs is refused, not handed to the renderer", async () => {
    // `{tokenData.name}` with an object throws inside React's render, and there
    // is no error boundary in this app, so the whole page unmounts.
    await assert.rejects(
        () =>
            fetchTokenMetadata(
                onChain({ name: { evil: 1 }, description: "x" })
            ),
        /expected format/
    );
});

test("an array where a string belongs is refused", async () => {
    await assert.rejects(
        () => fetchTokenMetadata(onChain({ description: ["a", "b"] })),
        /expected format/
    );
});

test("a top-level array instead of an object is refused", async () => {
    await assert.rejects(
        () => fetchTokenMetadata(onChain([1, 2, 3])),
        /expected format/
    );
});

test("a huge string is refused rather than rendered", async () => {
    await assert.rejects(
        () => fetchTokenMetadata(onChain({ name: "A".repeat(20000) })),
        /expected format/
    );
});

test("an explicit null field survives validation and stays null", async () => {
    // Real metadata omits optional fields by writing null. That is a token
    // saying it has no description, not a malformed token, and the page must
    // be able to tell those apart to report the second honestly.
    const result = await fetchTokenMetadata(
        onChain({ name: "N", description: null })
    );
    assert.equal(result.metadata.description, null);
});

test("markup in a name is preserved verbatim as text, never unwrapped", async () => {
    // React escapes it on render; the value must not be silently rewritten
    // here, or the page would show something the chain does not say.
    const payload = '<img src=x onerror="alert(1)">';
    const result = await fetchTokenMetadata(onChain({ name: payload }));
    assert.equal(result.metadata.name, payload);
});

test("unknown fields are stripped, so a javascript: external_link never reaches state", async () => {
    const result = await fetchTokenMetadata(
        onChain({
            name: "N",
            external_link: "javascript:alert(1)",
            animation_url: "https://evil.example/x",
            attributes: [{ trait_type: "a", value: 1 }],
        })
    );
    assert.equal(result.metadata.external_link, undefined);
    assert.equal(result.metadata.animation_url, undefined);
    assert.equal(result.metadata.attributes, undefined);
    assert.deepEqual(Object.keys(result.metadata), ["name"]);
});

test("an image field pointing at a private address issues no request", async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        return new Response("nope");
    };
    const result = await fetchTokenMetadata(
        onChain({
            name: "N",
            image: "http://169.254.169.254/latest/meta-data/",
        })
    );
    // The schema keeps it (it is a string), and the fetch policy refuses it.
    await assert.rejects(() => getTokenContent("image", result.metadata));
    assert.deepEqual(
        calls,
        [],
        "no request may be issued for a refused source"
    );
});

test("metadata that is not JSON at all is refused", async () => {
    await assert.rejects(() =>
        fetchTokenMetadata("data:application/json,not json")
    );
});

test("a gateway serving an error page with a 200 does not end the metadata fetch", async () => {
    // The fallback loop stopped at the first HTTP success, and the parse
    // happened outside it: one gateway's rate-limit interstitial made the token
    // unreadable even though the next configured gateway had the document.
    const cfg = await import("../src/config.js");
    const config = cfg.default || cfg;
    const seen = [];
    globalThis.fetch = async (url) => {
        seen.push(String(url));
        return String(url).startsWith(config.ipfsGateways[0])
            ? new Response("<html>Rate limited</html>", {
                  status: 200,
                  headers: { "content-type": "text/html" },
              })
            : new Response(JSON.stringify({ name: "Recovered" }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
              });
    };

    const result = await fetchTokenMetadata("ipfs://QmMetaInterstitial");
    assert.equal(result.metadata.name, "Recovered");
    assert.equal(seen.length, 2, "the working gateway must be reached");
});
