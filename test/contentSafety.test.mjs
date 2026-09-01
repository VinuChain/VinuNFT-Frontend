import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import Joi from "joi";

// tsx transpiles src/*.js to CommonJS, so named exports land on `default`.
// Same idiom as test/tokenMetadata.test.mjs.
const contentPolicy = await import("../src/common/contentPolicy.js");
const { evaluate, CONTENT_POLICY_URL, REPORT_URL } =
    contentPolicy.default || contentPolicy;

/**
 * Content governance: the blocklist, its entry schema, the reporting route and
 * the policy document.
 *
 * The blocklist is bundled by Gatsby, so a browser test cannot inject a fixture
 * entry. What is testable here is everything that decides an outcome — the pure
 * `evaluate`, the schema the shipped file must satisfy, and the presence of the
 * routes the UI points a reporter at. The three call-site conditionals are
 * proved by inverting the shipped file and rebuilding, not by this file.
 */

const BLOCKLIST_PATH = "src/content-blocklist.json";
const POLICY_PATH = "docs/content-policy.md";
const TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/content-report.yml";

const TOKEN_ENTRY = {
    scope: "token",
    key: "text/7",
    action: "hide",
    category: "illegal",
    reason: "Reported and confirmed as unlawful in the operator's jurisdiction.",
    evidence: "https://github.com/VinuChain/VinuNFT-Frontend/issues/1",
    addedAt: "2026-01-02T00:00:00Z",
    appeal: "Reply on the linked issue.",
};

const ADDRESS_ENTRY = {
    ...TOKEN_ENTRY,
    scope: "address",
    key: "0x1111111111111111111111111111111111111111",
    action: "warn",
    category: "impersonation",
    reason: "Claims to be a brand it is not.",
    appeal: "Open an issue naming the token and the evidence.",
};

// === evaluate: the whole decision, no I/O ===

test("a token-scoped entry hides exactly its own token", () => {
    const status = evaluate([TOKEN_ENTRY], { nftType: "text", tokenId: 7 });
    assert.equal(status.action, "hide");
    assert.equal(status.category, "illegal");
    assert.equal(
        evaluate([TOKEN_ENTRY], { nftType: "text", tokenId: 8 }),
        null
    );
    assert.equal(
        evaluate([TOKEN_ENTRY], { nftType: "image", tokenId: 7 }),
        null
    );
});

test("a warn entry carries its reason and appeal through verbatim", () => {
    const status = evaluate([ADDRESS_ENTRY], {
        nftType: "text",
        tokenId: 1,
        addresses: [ADDRESS_ENTRY.key],
    });
    assert.equal(status.action, "warn");
    assert.equal(status.reason, ADDRESS_ENTRY.reason);
    assert.equal(status.appeal, ADDRESS_ENTRY.appeal);
});

test("an address-scoped entry matches any named address, case-insensitively", () => {
    const author = ADDRESS_ENTRY.key.toUpperCase().replace("0X", "0x");
    assert.equal(
        evaluate([ADDRESS_ENTRY], { addresses: [author] }).action,
        "warn"
    );
    assert.equal(
        evaluate([ADDRESS_ENTRY], {
            addresses: ["0x2222222222222222222222222222222222222222"],
        }),
        null
    );
    // A missing address list must not throw and must not match.
    assert.equal(
        evaluate([ADDRESS_ENTRY], { nftType: "text", tokenId: 1 }),
        null
    );
});

test("hide wins over warn when both match", () => {
    const warnToken = { ...TOKEN_ENTRY, action: "warn", category: "abuse" };
    const status = evaluate([warnToken, TOKEN_ENTRY], {
        nftType: "text",
        tokenId: 7,
    });
    assert.equal(status.action, "hide");
});

test("an empty blocklist decides nothing", () => {
    assert.equal(evaluate([], { nftType: "text", tokenId: 7 }), null);
    assert.equal(evaluate(undefined, { nftType: "text", tokenId: 7 }), null);
});

// === the shipped file must be reviewable ===

const CATEGORIES = [
    "illegal",
    "infringing",
    "impersonation",
    "fraud",
    "abuse",
    "malware",
];

// The schema lives here, not in src: entries change only by pull request and
// this suite gates every pull request, so shipping a validator to the browser
// would be dead weight in the bundle.
const entrySchema = Joi.object({
    scope: Joi.string().valid("token", "address").required(),
    key: Joi.string().min(1).required(),
    action: Joi.string().valid("hide", "warn").required(),
    category: Joi.string()
        .valid(...CATEGORIES)
        .required(),
    reason: Joi.string().min(10).required(),
    evidence: Joi.string().min(1).required(),
    addedAt: Joi.string().isoDate().required(),
    appeal: Joi.string().min(10).required(),
});

const blocklistSchema = Joi.object({
    version: Joi.number().integer().min(1).required(),
    entries: Joi.array().items(entrySchema).required(),
});

test("every shipped blocklist entry carries reason, scope, category, evidence and appeal", () => {
    const shipped = JSON.parse(readFileSync(BLOCKLIST_PATH, "utf8"));
    Joi.assert(shipped, blocklistSchema);
});

test("the schema rejects an entry missing any required field", () => {
    // Anti-vacuity: with an empty shipped list the check above passes trivially,
    // so the schema itself has to be shown to have teeth.
    for (const key of Object.keys(TOKEN_ENTRY)) {
        const { [key]: _dropped, ...incomplete } = TOKEN_ENTRY;
        assert.ok(
            entrySchema.validate(incomplete).error,
            `dropping ${key} must be rejected`
        );
    }
    assert.ok(
        entrySchema.validate({ ...TOKEN_ENTRY, category: "spam" }).error,
        "an unclassified category must be rejected"
    );
    assert.ok(
        entrySchema.validate({ ...TOKEN_ENTRY, action: "delete" }).error,
        "the blocklist must not offer an action it cannot perform"
    );
    assert.ok(!entrySchema.validate(TOKEN_ENTRY).error, "the fixture is valid");
});

// === the reporting route ===

test("the content report template asks for what a takedown needs", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    for (const id of [
        "contract",
        "token_id",
        "category",
        "evidence",
        "rights_holder",
        "contact",
    ]) {
        assert.match(
            template,
            new RegExp(`id:\\s*${id}\\b`),
            `the template must collect ${id}`
        );
    }
});

test(
    "the footer offers the reporting route and the policy",
    { skip: !existsSync("public/index.html") },
    () => {
        // The footer is server-rendered, so this needs no browser.
        const html = readFileSync("public/index.html", "utf8");
        assert.ok(
            html.includes("issues/new?template=content-report.yml"),
            "a reporting link must be reachable from every page"
        );
        assert.ok(
            html.includes("blob/main/docs/content-policy.md"),
            "the content policy must be linked; docs/ is not copied into public/"
        );
    }
);

test("the UI and the footer point at the same routes", () => {
    assert.ok(REPORT_URL.includes("issues/new?template=content-report.yml"));
    assert.ok(CONTENT_POLICY_URL.includes("blob/main/docs/content-policy.md"));
});

// === the policy document ===

test("the policy separates the five layers and their limits", () => {
    const doc = readFileSync(POLICY_PATH, "utf8");
    for (const layer of [
        "Chain data",
        "Indexed data",
        "Hosted media",
        "Frontend visibility",
        "Wallet ownership",
    ]) {
        assert.match(
            doc,
            new RegExp(`^#+ .*${layer}`, "im"),
            `${layer} must be its own section`
        );
    }
});

test("the policy never promises that on-chain content can be deleted", () => {
    const doc = readFileSync(POLICY_PATH, "utf8");
    const overclaim =
        /\b(we|VinuNFT)\b[^.]*\b(can|will)\b[^.]*\b(delete|remove|erase)\b[^.]*\b(on-chain|blockchain|chain data|the chain)\b/i;
    const offending = doc
        .split(/(?<=\.)\s+/)
        .filter((sentence) => overclaim.test(sentence));
    assert.deepEqual(offending, []);
});

test("the takedown procedure names the unpin step and what it does not achieve", () => {
    const doc = readFileSync(POLICY_PATH, "utf8");
    assert.match(doc, /unpin/i, "the only hosted media is a Pinata pin");
    assert.match(doc, /PINATA_API_JWT/, "the credential is server-held");
    assert.match(
        doc,
        /does not (change|alter)[^.]*token URI/i,
        "unpinning leaves the on-chain URI pointing at the same CID"
    );
    assert.match(
        doc,
        /third[- ]party pin/i,
        "a CID pinned elsewhere survives our unpin"
    );
});
