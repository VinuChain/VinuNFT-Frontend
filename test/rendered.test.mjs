import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
} from "./helpers/browserHarness.mjs";

const ROUTES = [
    ["/", "Home"],
    ["/marketplace/", "Marketplace"],
    ["/activity/", "Activity"],
    ["/mint/", "Create"],
    ["/address/", "Profile"],
    ["/bridge/", "Bridge"],
    ["/media/", "Media"],
];

let server;
let browser;
let origin;

before(async () => {
    if (!hasBuild) return;
    const { chromium } = await import("playwright");
    ({ server, origin } = await startStaticServer());
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

    await routeOffline(page, origin);
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

// --- accessibility: contrast, target size, motion -------------------------

/** WCAG relative luminance and contrast ratio, computed in the page. */
const CONTRAST_HELPERS = `
    const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
        const f = (v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };
    const backdrop = (el) => {
        for (let n = el; n; n = n.parentElement) {
            const bg = parse(getComputedStyle(n).backgroundColor);
            const alpha = bg.length === 4 ? bg[3] : 1;
            if (alpha > 0) return bg.slice(0, 3);
        }
        return [255, 255, 255];
    };
`;

for (const [path, label] of ROUTES) {
    test(`${label}: visible text meets WCAG AA contrast`, { skip: !hasBuild }, async () => {
        const { page, context } = await open(path);
        try {
            const failures = await page.evaluate(`(() => {
                ${CONTRAST_HELPERS}
                const bad = [];
                for (const el of document.querySelectorAll("p, span, a, button, h1, h2, h3, h4, li, td, th, label, strong, small, tt")) {
                    if (!el.textContent.trim()) continue;
                    if (el.querySelector("*")) continue;           // leaf text only
                    const cs = getComputedStyle(el);
                    if (cs.visibility === "hidden" || cs.display === "none") continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    if (Number(cs.opacity) === 0) continue;
                    const size = parseFloat(cs.fontSize);
                    const bold = Number(cs.fontWeight) >= 700;
                    // WCAG AA: 3.0 for large text (>=24px, or >=18.66px bold), else 4.5
                    const required = size >= 24 || (bold && size >= 18.66) ? 3.0 : 4.5;
                    const r = ratio(parse(cs.color).slice(0, 3), backdrop(el));
                    if (r + 0.05 < required) {
                        bad.push(el.tagName + " '" + el.textContent.trim().slice(0, 30) + "' " + r.toFixed(2) + ":1 < " + required);
                    }
                }
                return [...new Set(bad)];
            })()`);
            assert.deepEqual(failures, [], `${path} has text below AA contrast`);
        } finally {
            await context.close();
        }
    });

    test(`${label}: interactive targets are large enough to tap`, { skip: !hasBuild }, async () => {
        const { page, context } = await open(path, { viewport: { width: 375, height: 667 } });
        try {
            // WCAG 2.5.8 AA: 24x24 CSS px minimum for pointer targets.
            const small = await page.$$eval("button, a[href], input, select, textarea", (nodes) =>
                nodes
                    .filter((node) => {
                        const cs = getComputedStyle(node);
                        if (cs.display === "none" || cs.visibility === "hidden") return false;
                        const r = node.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) return false;
                        return r.width < 24 || r.height < 24;
                    })
                    .map((node) => `${node.tagName} '${(node.textContent ?? "").trim().slice(0, 24)}' ${Math.round(node.getBoundingClientRect().width)}x${Math.round(node.getBoundingClientRect().height)}`)
            );
            assert.deepEqual([...new Set(small)], [], `${path} has targets under 24x24`);
        } finally {
            await context.close();
        }
    });
}

test("no element animates indefinitely when reduced motion is requested", { skip: !hasBuild }, async () => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await routeOffline(page, origin);
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    try {
        const animating = await page.$$eval("*", (nodes) =>
            nodes
                .filter((node) => {
                    const cs = getComputedStyle(node);
                    return (
                        cs.animationIterationCount === "infinite" &&
                        cs.animationName !== "none" &&
                        cs.animationPlayState === "running"
                    );
                })
                .map((node) => `${node.tagName}.${String(node.className).slice(0, 30)}`)
        );
        assert.deepEqual([...new Set(animating)], [], "infinite animation under prefers-reduced-motion");
    } finally {
        await context.close();
    }
});
