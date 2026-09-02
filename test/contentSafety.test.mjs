import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import Joi from "joi";

// tsx transpiles src/*.js to CommonJS, so named exports land on `default`.
// Same idiom as test/tokenMetadata.test.mjs.
const contentPolicy = await import("../src/common/contentPolicy.js");
const {
    evaluate,
    decideContent,
    partitionListings,
    CONTENT_POLICY_URL,
    REPORT_URL,
} = contentPolicy.default || contentPolicy;

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

// === the decision, while the creator is still being read ===

const CREATOR = "0x5555555555555555555555555555555555555555";
const HIDE_CREATOR = { ...ADDRESS_ENTRY, action: "hide", key: CREATOR };

test("a token whose creator is not yet read has no decision, not a permission", () => {
    // `authorOf` is a contract read. Before it lands the page cannot know
    // whether an address entry applies, and "unknown" must not be spent as
    // permission to fetch the very media the entry exists to suppress.
    const pending = decideContent(
        [HIDE_CREATOR],
        { nftType: "text", tokenId: 1, addresses: [null] },
        { creatorKnown: false }
    );
    assert.equal(
        pending.hidden,
        null,
        "an unread creator is undecided, never not-hidden"
    );

    assert.equal(
        decideContent(
            [HIDE_CREATOR],
            { nftType: "text", tokenId: 1, addresses: [CREATOR] },
            { creatorKnown: true }
        ).hidden,
        true
    );
    assert.equal(
        decideContent(
            [HIDE_CREATOR],
            { nftType: "text", tokenId: 1, addresses: [OTHER_ADDRESS] },
            { creatorKnown: true }
        ).hidden,
        false,
        "a creator that matches nothing decides the token is shown"
    );
});

test("a token-scoped hide is certain without waiting for the creator", () => {
    // Nothing the creator read can return would change this, so the page has
    // no reason to hold the decision open.
    assert.equal(
        decideContent([TOKEN_ENTRY], { nftType: "text", tokenId: 7 }, {
            creatorKnown: false,
        }).hidden,
        true
    );
});

test("the tri-state carries the status the notice renders, unchanged", () => {
    const decision = decideContent(
        [ADDRESS_ENTRY],
        { addresses: [ADDRESS_ENTRY.key] },
        { creatorKnown: true }
    );
    assert.equal(decision.status.action, "warn");
    assert.equal(decision.status.reason, ADDRESS_ENTRY.reason);
    assert.equal(decision.hidden, false, "a warning is not a suppression");
});

test("both render paths wait for the decision before fetching media", () => {
    // The seam is only worth having if the pages actually gate on it, and a
    // falsy check reads "undecided" as "allowed".
    for (const path of ["src/pages/nft/index.js", "src/components/NFTCard.js"]) {
        const source = readFileSync(path, "utf8");
        assert.match(
            source,
            /contentHidden !== false/,
            `${path} must stop on an undecided policy, not only on a hide`
        );
        assert.equal(
            /if \(contentHidden\) return/.test(source),
            false,
            `${path} must not treat a pending decision as permission to fetch`
        );
        // A creator read that FAILED is an unknown creator, not an absent one.
        // Resolving the decision in a `finally` resolved it on every branch,
        // so one flaky RPC response switched creator-scoped suppression off
        // and the media was fetched anyway.
        assert.equal(
            /finally\s*\{[^}]*setAuthorRead\(true\)/s.test(source),
            false,
            `${path} must resolve the creator decision only on a read that landed`
        );
        // The author read re-runs — the token page repeats it on every
        // `updateTracker` tick — so a failure can FOLLOW a success. Clearing
        // the author without clearing the decision would turn an already
        // hidden token into a shown one and fetch the media it hid.
        const read = source.match(
            /queryTokenAuthor = async \(\) => \{[\s\S]*?\n    \};/
        );
        assert.ok(read, `${path} must read the creator in one function`);
        assert.match(
            read[0],
            /catch[\s\S]*setAuthorRead\(false\)/,
            `${path} must un-decide the policy when an author read fails`
        );
    }
});

// === listings: the seller scope, wherever a listing is offered ===

const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";
const SELLER = "0x3333333333333333333333333333333333333333";
const OTHER_SELLER = "0x4444444444444444444444444444444444444444";
const HIDE_SELLER = { ...ADDRESS_ENTRY, action: "hide", key: SELLER };

test("an entry naming the seller withdraws that listing from sale", () => {
    const listings = [
        { nftType: "text", tokenId: 1, seller: SELLER },
        { nftType: "text", tokenId: 1, seller: OTHER_SELLER },
    ];
    const { shown, hiddenByPolicy } = partitionListings(
        [HIDE_SELLER],
        listings
    );

    assert.deepEqual(
        shown.map((listing) => listing.seller),
        [OTHER_SELLER],
        "a blocklisted seller must not be offered, whoever else is"
    );
    assert.equal(
        hiddenByPolicy,
        1,
        "the count is disclosed, so the visible rows and the totals agree"
    );
});

test("a listing row that names only its seller inherits the token it is on", () => {
    // The token page reads `listings(nftAddress, id, i)`: those rows carry a
    // seller and an amount, and the collection and id are the page's own.
    const { shown, hiddenByPolicy } = partitionListings(
        [TOKEN_ENTRY],
        [{ seller: OTHER_SELLER }],
        { nftType: "text", tokenId: 7 }
    );

    assert.deepEqual(shown, []);
    assert.equal(hiddenByPolicy, 1);
});

test("a warn entry still leaves the listing for sale", () => {
    // warn is a caution, not a withdrawal: only `hide` removes an offer.
    const { shown } = partitionListings(
        [{ ...ADDRESS_ENTRY, key: SELLER }],
        [{ nftType: "text", tokenId: 1, seller: SELLER }]
    );
    assert.equal(shown.length, 1);
});

test("an empty blocklist withdraws nothing and counts nothing", () => {
    const listings = [{ nftType: "text", tokenId: 1, seller: SELLER }];
    assert.deepEqual(partitionListings([], listings), {
        shown: listings,
        hiddenByPolicy: 0,
    });
    assert.deepEqual(partitionListings([], undefined), {
        shown: [],
        hiddenByPolicy: 0,
    });
});

test("every place that offers a listing applies the policy through one helper", () => {
    // The documented seller scope is only real if each offering path uses it.
    // Both pages sell: the marketplace lists them, the token page groups them
    // behind a Buy button.
    for (const path of ["src/pages/marketplace.js", "src/pages/nft/index.js"]) {
        const source = readFileSync(path, "utf8");
        assert.match(
            source,
            /visibleListings\(/,
            `${path} must decide through the shared helper`
        );
        assert.equal(
            /(contentStatus|contentDecision|evaluate)\(\{[^}]*seller/s.test(
                source
            ),
            false,
            `${path} must not re-implement the seller predicate inline`
        );
    }
    // The token page's rows carry no creator, so it must hand over the one it
    // read; the marketplace rows already carry theirs.
    assert.match(
        readFileSync("src/pages/nft/index.js", "utf8"),
        /visibleListings\([\s\S]{0,200}?creator: tokenAuthor/,
        "the token page must offer listings against the creator it resolved"
    );
});

test("an entry naming a token's creator withdraws it from sale, whoever resells it", () => {
    // The documented address scope is creator OR seller, and a token this
    // deployment will not show is a token it must not offer. The creator is on
    // the marketplace row already (`listingRowsFromIndex` carries it), so a
    // blocklisted minter's work is not purchasable here through a reseller.
    const { shown, hiddenByPolicy } = partitionListings(
        [HIDE_CREATOR],
        [
            { nftType: "text", tokenId: 1, seller: OTHER_SELLER, creator: CREATOR },
            { nftType: "text", tokenId: 2, seller: OTHER_SELLER, creator: OTHER_ADDRESS },
        ]
    );

    assert.deepEqual(
        shown.map((listing) => listing.tokenId),
        [2],
        "a hide on the creator must withdraw the row even when the seller is clean"
    );
    assert.equal(hiddenByPolicy, 1);
});

test("a listing row with no creator of its own inherits the page's", () => {
    // The token page's rows come from `listings(nftAddress, id, i)`: they name
    // a seller and an amount, and the creator is the page's own `authorOf`
    // read. Without this the page hid a blocklisted creator's media while
    // still offering their token behind a Buy button.
    assert.deepEqual(
        partitionListings([HIDE_CREATOR], [{ seller: OTHER_SELLER }], {
            nftType: "text",
            tokenId: 7,
            creator: CREATOR,
        }),
        { shown: [], hiddenByPolicy: 1 }
    );
    assert.equal(
        partitionListings([HIDE_CREATOR], [{ seller: OTHER_SELLER }], {
            nftType: "text",
            tokenId: 7,
            creator: OTHER_ADDRESS,
        }).shown.length,
        1,
        "a creator no entry names leaves the row for sale"
    );
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

test("the documented address scope is the one the code can apply", () => {
    // A doc that promises more suppression than the code performs is itself a
    // defect: owner-scoped hiding was documented and never implemented.
    const doc = readFileSync(POLICY_PATH, "utf8");
    const scope = doc.match(/Address-scoped entries match[^.]*\./s);
    assert.ok(scope, "the policy must state what an address entry matches");
    assert.match(scope[0], /creator/i);
    assert.match(scope[0], /seller/i);
    assert.equal(
        /owner/i.test(scope[0]),
        false,
        "no owner scope is implemented: the creator and the seller are the only addresses any call site knows"
    );
    // The address branch of `matches` states the same scope to the next
    // reader of the code; the two must not drift apart.
    const branch = readFileSync("src/common/contentPolicy.js", "utf8").match(
        /if \(entry\.scope === "address"\)[\s\S]*?\n    \}/
    );
    assert.ok(branch, "the address scope must be decided in one place");
    assert.equal(
        /owner/i.test(branch[0]),
        false,
        "the module comment must not promise the owner scope either"
    );
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
