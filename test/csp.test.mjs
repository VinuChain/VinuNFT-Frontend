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

test("img-src names the gateways it trusts instead of every https host", { skip: !hasBuild }, () => {
    // A bare `https:` let a minted NFT body reference an image on any host and
    // beacon every viewer's IP and User-Agent to the minter. Markdown/HTML NFT
    // images never pass through maybeFetchIpfs, so CSP is the only control.
    const img = directive(builtCsp(), "img-src");
    assert.equal(
        /(^|\s)https:(\s|$)/.test(img),
        false,
        `img-src must not allow every https host: ${img}`
    );
    for (const gateway of config.ipfsGateways) {
        const origin = new URL(gateway).origin;
        assert.ok(
            img.includes(origin),
            `img-src must allow ${origin}, or a gateway-hosted NFT image is blocked: ${img}`
        );
    }
});

test("form-action is closed, since no form in this app posts anywhere", { skip: !hasBuild }, () => {
    // form-action does not inherit from default-src.
    assert.match(directive(builtCsp(), "form-action"), /'none'/);
});

test("connect-src allows the ENS provider the address components call", { skip: !hasBuild }, () => {
    // src/common/provider.js builds an ethers 5 AlchemyProvider for mainnet,
    // which talks to this host. Without it every useEns lookup is refused in
    // production and no ENS name ever resolves, while dev serves no CSP.
    const connect = directive(builtCsp(), "connect-src");
    assert.ok(connect.includes("https://eth-mainnet.alchemyapi.io"), connect);
});

test("every built page hash-allows its own inline scripts", { skip: !hasBuild }, async () => {
    // add_csp used to match only the `script-src 'self'` seed. On a warm build
    // Gatsby reuses page HTML it already expanded, so the seed is gone, the
    // replace silently did nothing, and the shipped policy still pinned the
    // previous build's ___chunkMapping and ___webpackCompilationHash — every
    // page shipped unable to run its own bootstrap.
    const { readdirSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const walk = (dir) =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory()
                ? walk(`${dir}/${entry.name}`)
                : entry.name.endsWith(".html")
                ? [`${dir}/${entry.name}`]
                : []
        );

    // public/_gatsby holds slice fragments that are stitched into pages, not
    // documents the browser ever loads on their own.
    const pages = walk("public").filter(
        (page) => !page.startsWith("public/_gatsby/")
    );
    assert.ok(pages.length > 1, "the build produced no pages to check");

    for (const page of pages) {
        const html = readFileSync(page, "utf8");
        const csp = html.match(
            /<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i
        );
        assert.ok(csp, `${page} carries no CSP meta tag`);
        const inline = [
            ...html.matchAll(
                /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g
            ),
        ].map((match) => match[1]);
        for (const script of inline) {
            const hash = createHash("sha256").update(script).digest("base64");
            assert.ok(
                csp[1].includes(`sha256-${hash}`),
                `${page} blocks its own inline script (sha256-${hash}): ${script.slice(0, 80)}`
            );
        }
    }
});
