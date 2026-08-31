import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

const cfg = await import("../src/config.js");
const config = cfg.default || cfg;

const BUILT_PAGE = "public/index.html";
const hasBuild = existsSync(BUILT_PAGE);

function builtCsp() {
    const html = readFileSync(BUILT_PAGE, "utf8");
    // The policy value itself contains single quotes ('self', 'none', hashes),
    // so the capture must be delimited by the double quote only.
    const match = html.match(
        /<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i
    );
    assert.ok(match, "the built page must carry a Content-Security-Policy meta tag");
    return match[1];
}

const directive = (csp, name) => {
    const found = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
    assert.ok(found, `CSP is missing a ${name} directive: ${csp}`);
    return found;
};

test("add_csp derives its gateway origins from config rather than repeating them", () => {
    const source = readFileSync("add_csp.js", "utf8");
    // A hard-coded copy silently blocks whichever gateways config adds later,
    // which is what happened when the fallback gateways were introduced.
    assert.match(source, /ipfsGatewayOrigins\(\)/);
    assert.equal(
        source.includes('"https://gateway.pinata.cloud"'),
        false,
        "gateway origins must not be duplicated in add_csp.js"
    );
});

test("config declares more than one IPFS gateway, so fallback is real", () => {
    assert.ok(Array.isArray(config.ipfsGateways));
    assert.ok(config.ipfsGateways.length > 1);
});

test("every configured IPFS gateway is allowed by connect-src", { skip: !hasBuild }, () => {
    const connect = directive(builtCsp(), "connect-src");
    for (const gateway of config.ipfsGateways) {
        const origin = new URL(gateway).origin;
        assert.ok(
            connect.includes(origin),
            `connect-src must allow ${origin}, or that gateway fallback is dead in production: ${connect}`
        );
    }
});

test("connect-src allows the chain RPC the app actually reads from", { skip: !hasBuild }, () => {
    const connect = directive(builtCsp(), "connect-src");
    assert.ok(connect.includes(new URL(config.rpc).origin), connect);
});

test("img-src allows blob:, which is how token images are rendered", { skip: !hasBuild }, () => {
    // Media is fetched with a byte cap and handed to <img> via
    // URL.createObjectURL; without blob: every image NFT is blocked.
    assert.match(directive(builtCsp(), "img-src"), /\bblob:/);
});

test("the policy keeps its restrictive defaults", { skip: !hasBuild }, () => {
    const csp = builtCsp();
    assert.match(directive(csp, "default-src"), /'self'/);
    assert.match(directive(csp, "object-src"), /'none'/);
    assert.match(directive(csp, "base-uri"), /'self'/);
    assert.match(directive(csp, "frame-ancestors"), /'self'/);
});

test("script-src is hash-pinned and allows no inline or eval escape hatch", { skip: !hasBuild }, () => {
    const scriptSrc = directive(builtCsp(), "script-src");
    assert.match(scriptSrc, /'sha256-/, "inline scripts must be hash-pinned");
    assert.equal(scriptSrc.includes("'unsafe-inline'"), false);
    assert.equal(scriptSrc.includes("'unsafe-eval'"), false);
    assert.equal(scriptSrc.includes("*"), false);
});

test("the placeholder is fully expanded, leaving no bare script-src", { skip: !hasBuild }, () => {
    const html = readFileSync(BUILT_PAGE, "utf8");
    assert.equal(
        html.includes("script-src &#x27;self&#x27;\""),
        false,
        "an unexpanded placeholder means add_csp did not run"
    );
});

test("the built HTML references a stylesheet that exists in the build", { skip: !hasBuild }, async () => {
    // Gatsby's incremental build can leave HTML referencing a stylesheet hash
    // from an earlier run. Every rendered assertion then measures stale CSS and
    // silently reports the previous build's behaviour — which is exactly what
    // happened while chasing accessibility fixes that had in fact applied.
    const { readdirSync } = await import("node:fs");
    const built = new Set(
        readdirSync("public").filter((f) => /^styles\..*\.css$/.test(f))
    );
    const html = readFileSync(BUILT_PAGE, "utf8");
    const referenced = [...new Set(html.match(/styles\.[a-f0-9]+\.css/g) ?? [])];

    assert.ok(referenced.length > 0, "the page references no stylesheet");
    for (const name of referenced) {
        assert.ok(built.has(name), `${name} is referenced but not present in public/`);
    }
    assert.equal(
        built.size,
        referenced.length,
        `public/ holds ${built.size} stylesheets for ${referenced.length} referenced — stale output from an earlier build; run 'yarn clean' before building`
    );
});
