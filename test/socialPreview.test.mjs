import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("../src/common/socialPreview.js");
const { parseNftRoute, socialPreview } = mod.default || mod;

const GENERIC = {
    title: "VinuNFT",
    description: "VinuNFT on VinuChain mainnet.",
    url: "/nft",
    imageAlt: "VinuNFT",
};

// --- route parsing ----------------------------------------------------------

test("valid route parameters are accepted", () => {
    assert.deepEqual(parseNftRoute({ type: "text", id: "1" }), { type: "text", id: 1 });
    assert.deepEqual(parseNftRoute({ type: "image", id: "4242" }), { type: "image", id: 4242 });
});

test("an unrecognised type is rejected rather than echoed", () => {
    for (const type of ["html", "TEXT", "../text", "<b>", "", null, undefined, 7]) {
        assert.equal(parseNftRoute({ type, id: "1" }).type, null, `type ${type}`);
    }
});

test("only a positive integer id is accepted", () => {
    // parseInt alone accepts all of these, which is how "#NaN" reached the
    // page title and how a negative id reached contract reads.
    for (const id of ["0", "-1", "5abc", "1.5", "1e3", " 1", "<script>", "", null, undefined, "0x1"]) {
        assert.equal(parseNftRoute({ type: "text", id }).id, null, `id ${JSON.stringify(id)}`);
    }
});

test("a very large id is still parsed as a number", () => {
    assert.equal(parseNftRoute({ type: "text", id: "999999999" }).id, 999999999);
});

test("a missing query object does not throw", () => {
    assert.deepEqual(parseNftRoute(undefined), { type: null, id: null });
    assert.deepEqual(parseNftRoute(null), { type: null, id: null });
});

// --- preview values ---------------------------------------------------------

test("a valid token produces a preview naming only its type and id", () => {
    assert.deepEqual(socialPreview({ type: "image", id: "12" }), {
        title: "image #12 - VinuNFT",
        description: "View image NFT #12 on VinuNFT.",
        url: "/nft?type=image&id=12",
        imageAlt: "image NFT #12",
    });
});

test("hostile route parameters fall back to the generic preview", () => {
    const payloads = [
        { type: '"><script>alert(1)</script>', id: "1" },
        { type: "text", id: '"><img src=x onerror=alert(1)>' },
        { type: "javascript:alert(1)", id: "javascript:alert(1)" },
        { type: "text", id: "1'\"><svg onload=alert(1)>" },
        { type: "../../etc/passwd", id: "../../etc/passwd" },
        { type: "text", id: "https://evil.example/track" },
    ];
    for (const payload of payloads) {
        const preview = socialPreview(payload);
        for (const value of Object.values(preview)) {
            assert.ok(
                !/[<>"']/.test(value),
                `markup characters reached a social tag from ${JSON.stringify(payload)}: ${value}`
            );
        }
        // A hostile id yields no token, so the whole preview is generic.
        if (payload.id !== "1") assert.deepEqual(preview, GENERIC);
    }
});

test("an unknown type with a valid id degrades to a neutral label, not the input", () => {
    const preview = socialPreview({ type: "<b>evil</b>", id: "3" });
    assert.equal(preview.title, "NFT #3 - VinuNFT");
    assert.ok(!preview.title.includes("evil"));
    assert.equal(preview.url, "/nft?type=NFT&id=3");
});

test("no preview value can contain a URL scheme that could be fetched", () => {
    for (const payload of [
        { type: "text", id: "1" },
        { type: "image", id: "999" },
        { type: "bogus", id: "bogus" },
    ]) {
        for (const value of Object.values(socialPreview(payload))) {
            assert.ok(
                !/https?:|ipfs:|data:|javascript:/i.test(value),
                `a fetchable URL reached a social tag: ${value}`
            );
        }
    }
});

test("token metadata offered alongside the route cannot reach a preview value", () => {
    // Names and descriptions are attacker-controlled and are rendered by third
    // parties whose escaping is not ours to rely on. Even when metadata-shaped
    // fields ride along with the query, the preview must ignore them.
    const preview = socialPreview({
        type: "text",
        id: "7",
        name: "PWNED-NAME",
        description: "PWNED-DESCRIPTION",
        image: "https://evil.example/PWNED-IMAGE.png",
        external_link: "javascript:alert(1)",
        tokenData: { name: "PWNED-TOKENDATA" },
    });

    const rendered = Object.values(preview).join(" ");
    for (const marker of [
        "PWNED-NAME",
        "PWNED-DESCRIPTION",
        "PWNED-IMAGE",
        "PWNED-TOKENDATA",
        "evil.example",
        "javascript:",
    ]) {
        assert.ok(!rendered.includes(marker), `${marker} reached a social tag: ${rendered}`);
    }

    // It still produced the correct preview from the route alone.
    assert.equal(preview.title, "text #7 - VinuNFT");
});
