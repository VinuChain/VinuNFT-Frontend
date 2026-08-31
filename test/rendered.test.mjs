import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const PUBLIC_DIR = "public";
const hasBuild = existsSync(join(PUBLIC_DIR, "index.html"));

const ROUTES = [
    ["/", "Home"],
    ["/marketplace/", "Marketplace"],
    ["/activity/", "Activity"],
    ["/mint/", "Create"],
    ["/address/", "Profile"],
    ["/bridge/", "Bridge"],
    ["/media/", "Media"],
];

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".txt": "text/plain",
};

let server;
let browser;
let origin;

before(async () => {
    if (!hasBuild) return;
    const { chromium } = await import("playwright");

    // Serve the real production build, so the CSP meta tag, bundle splitting
    // and hashed assets are exactly what ships.
    server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://localhost");
            let filePath = join(PUBLIC_DIR, normalize(decodeURIComponent(url.pathname)));
            if (!filePath.startsWith(PUBLIC_DIR)) {
                res.writeHead(403).end();
                return;
            }
            const info = await stat(filePath).catch(() => null);
            if (info?.isDirectory()) filePath = join(filePath, "index.html");
            const body = await readFile(filePath);
            res.writeHead(200, {
                "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
            });
            res.end(body);
        } catch {
            res.writeHead(404, { "content-type": "text/html" }).end("not found");
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

/** Open a route with chain traffic stubbed, collecting console and page errors. */
async function open(path, { viewport } = {}) {
    const context = await browser.newContext(
        viewport ? { viewport, hasTouch: true, isMobile: true } : {}
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    // Keep the run offline and deterministic: no real RPC, IPFS or bridge calls.
    await page.route("**://**", (route) => {
        const url = route.request().url();
        if (url.startsWith(origin)) return route.continue();
        if (url.includes("rpc.vinuchain.org")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }),
            });
        }
        return route.abort();
    });

    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    return { page, context, errors };
}

// --- every route renders ----------------------------------------------------

for (const [path, label] of ROUTES) {
    test(`${label} (${path}) renders without a page error`, { skip: !hasBuild }, async () => {
        const { page, context, errors } = await open(path);
        try {
            const body = (await page.textContent("body")) ?? "";
            assert.ok(body.trim().length > 0, `${path} rendered an empty body`);

            // A crashed React tree leaves the shell but no interactive chrome.
            assert.ok(
                (await page.locator("nav, header").count()) > 0,
                `${path} rendered no navigation chrome`
            );

            const fatal = errors.filter(
                (e) =>
                    e.startsWith("pageerror:") &&
                    !/Failed to fetch|NetworkError|net::ERR/i.test(e)
            );
            assert.deepEqual(fatal, [], `${path} raised uncaught errors`);
        } finally {
            await context.close();
        }
    });
}

test("the served document carries the built Content-Security-Policy", { skip: !hasBuild }, async () => {
    // Read the response body, not the hydrated DOM. react-helmet re-renders the
    // meta tag on hydration and restores the bare `script-src 'self'`
    // placeholder that add_csp.js uses as its injection anchor. That does not
    // relax anything — a browser applies a meta CSP while parsing and ignores
    // later mutations of it — but it does mean the live DOM is the wrong place
    // to assert the policy.
    const response = await fetch(`${origin}/`);
    const html = await response.text();
    const match = html.match(
        /<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i
    );
    assert.ok(match, "no CSP meta tag was served");
    assert.match(match[1], /blob:/);
    assert.match(match[1], /object-src 'none'/);
    assert.match(match[1], /'sha256-/);
});

// --- mobile -----------------------------------------------------------------

const PHONE = { width: 375, height: 667 };

for (const [path, label] of ROUTES) {
    test(`${label} has no horizontal overflow on a 375px phone`, { skip: !hasBuild }, async () => {
        const { page, context } = await open(path, { viewport: PHONE });
        try {
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth
            );
            // A few pixels of rounding is tolerable; a sideways-scrolling page
            // is the defining mobile-layout failure.
            assert.ok(overflow <= 2, `${path} overflows horizontally by ${overflow}px`);
        } finally {
            await context.close();
        }
    });
}

// --- accessibility basics ---------------------------------------------------

test("the document declares a language", { skip: !hasBuild }, async () => {
    const { page, context } = await open("/");
    try {
        assert.ok(await page.getAttribute("html", "lang"), "html needs a lang attribute");
    } finally {
        await context.close();
    }
});

for (const [path, label] of ROUTES) {
    test(`${label}: every image has an alt attribute`, { skip: !hasBuild }, async () => {
        const { page, context } = await open(path);
        try {
            const missing = await page.$$eval("img", (imgs) =>
                imgs
                    .filter((img) => !img.hasAttribute("alt"))
                    .map((img) => img.getAttribute("src") ?? "(no src)")
            );
            assert.deepEqual(missing, [], `${path} has images without alt text`);
        } finally {
            await context.close();
        }
    });

    test(`${label}: every control has an accessible name`, { skip: !hasBuild }, async () => {
        const { page, context } = await open(path);
        try {
            const unnamed = await page.$$eval("button, a[href]", (nodes) =>
                nodes
                    .filter((node) => {
                        const style = getComputedStyle(node);
                        if (style.display === "none" || style.visibility === "hidden") return false;
                        const name =
                            (node.textContent ?? "").trim() ||
                            node.getAttribute("aria-label") ||
                            node.getAttribute("title") ||
                            node.querySelector("img[alt]")?.getAttribute("alt");
                        return !name;
                    })
                    .map((node) => node.outerHTML.slice(0, 120))
            );
            assert.deepEqual(unnamed, [], `${path} has controls a screen reader cannot name`);
        } finally {
            await context.close();
        }
    });
}

test("keyboard focus reaches the primary navigation", { skip: !hasBuild }, async () => {
    const { page, context } = await open("/");
    try {
        const reached = [];
        for (let i = 0; i < 12; i++) {
            await page.keyboard.press("Tab");
            reached.push(
                await page.evaluate(() => {
                    const el = document.activeElement;
                    if (!el || el === document.body) return null;
                    return (el.textContent ?? "").trim().slice(0, 40) || el.tagName;
                })
            );
        }
        assert.ok(
            reached.some((entry) => entry && entry !== "BODY"),
            "tabbing reached no focusable element"
        );
    } finally {
        await context.close();
    }
});
