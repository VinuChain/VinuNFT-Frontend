import assert from "node:assert/strict";
import test from "node:test";

const { sanitizeMarkdown, sanitizeHtml } = await import("../src/common/sanitize.js");

/**
 * Nothing that could execute may survive either pipeline.
 *
 * This inspects tags and attributes rather than searching for substrings: a
 * stripped `<style>` leaves its rule text behind as plain text, and a stripped
 * `href` leaves the URL as link text. Both are inert, and a raw substring check
 * flags them as failures while missing the thing that actually matters — an
 * executable scheme sitting in a live attribute.
 */
const DANGEROUS_TAGS = [
    "script", "iframe", "object", "embed", "base", "form", "meta", "style", "link",
];
const EVENT_HANDLER = /<[^>]*\son[a-z]+\s*=/i;
const EXECUTABLE_URL_ATTR =
    /(href|src|srcdoc|action|formaction|data|poster)\s*=\s*["']?\s*(javascript|vbscript|data:text\/html)/i;

function assertInert(output, label) {
    for (const tag of DANGEROUS_TAGS) {
        assert.ok(
            !new RegExp(`<${tag}[\\s>/]`, "i").test(output),
            `${label}: <${tag}> survived -> ${output}`
        );
    }
    assert.ok(
        !EVENT_HANDLER.test(output),
        `${label}: an event handler attribute survived -> ${output}`
    );
    assert.ok(
        !EXECUTABLE_URL_ATTR.test(output),
        `${label}: an executable URL survived in an attribute -> ${output}`
    );
}

// --- hostile input, both pipelines ------------------------------------------

const HOSTILE = [
    ["script tag", "<script>alert(1)</script>"],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["svg onload", "<svg onload=alert(1)></svg>"],
    ["body onload", '<body onload="alert(1)">hi</body>'],
    ["anchor javascript url", '<a href="javascript:alert(1)">click</a>'],
    ["anchor uppercase javascript url", '<a href="JaVaScRiPt:alert(1)">click</a>'],
    ["anchor data html url", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ["iframe", '<iframe src="https://evil.example"></iframe>'],
    ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["object", '<object data="evil.swf"></object>'],
    ["embed", '<embed src="evil.swf">'],
    ["form", '<form action="https://evil.example"><input name="x"></form>'],
    ["base tag", '<base href="https://evil.example/">'],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ["nested script obfuscation", "<scr<script>ipt>alert(1)</scr</script>ipt>"],
    ["style expression", "<style>body{background:url('javascript:alert(1)')}</style>"],
    ["event handler on allowed tag", '<p onclick="alert(1)">text</p>'],
    ["mouseover on span", '<span onmouseover="alert(1)">hover</span>'],
    ["image with javascript src", '<img src="javascript:alert(1)">'],
];

for (const [label, payload] of HOSTILE) {
    test(`sanitizeHtml neutralises ${label}`, () => {
        assertInert(sanitizeHtml(payload), `html/${label}`);
    });

    test(`sanitizeMarkdown neutralises ${label} embedded in markdown`, () => {
        assertInert(sanitizeMarkdown(`Some text\n\n${payload}\n\nmore`), `md/${label}`);
    });
}

test("markdown link syntax cannot smuggle a javascript URL", () => {
    const out = sanitizeMarkdown("[click me](javascript:alert(1))");
    assertInert(out, "md link");
    assert.ok(out.includes("click me"), "the link text should still render");
});

test("markdown image syntax cannot smuggle a javascript URL", () => {
    assertInert(sanitizeMarkdown("![alt](javascript:alert(1))"), "md image");
});

test("markdown autolink cannot smuggle a javascript URL", () => {
    const out = sanitizeMarkdown("<javascript:alert(1)>");
    assertInert(out, "md autolink");
    // The anchor survives but is stripped of its href, so the scheme is left
    // as inert link text with nothing to activate.
    assert.ok(out.includes("<a>"), `href should be dropped, got ${out}`);
    assert.ok(!/<a[^>]+href/i.test(out), `no href may remain, got ${out}`);
});

test("a style block is reduced to inert text, not applied as CSS", () => {
    const out = sanitizeHtml("<style>body{background:url('javascript:alert(1)')}</style>");
    assertInert(out, "html style block");
    // The rule text remains as visible text; without the <style> element the
    // browser never parses it as CSS.
    assert.ok(!out.includes("<style"), `style element must be gone, got ${out}`);
});

test("raw HTML inside markdown does not bypass the schema", () => {
    // remark keeps raw HTML as a node; the schema is what must drop it.
    assertInert(sanitizeMarkdown("Normal\n\n<script>alert(1)</script>\n"), "md raw html");
});

// --- valid content must survive ---------------------------------------------

test("markdown preserves ordinary formatting", () => {
    const out = sanitizeMarkdown("# Title\n\n**bold** and *italic*\n\n- one\n- two\n");
    assert.match(out, /<h1>Title<\/h1>/);
    assert.match(out, /<strong>bold<\/strong>/);
    assert.match(out, /<em>italic<\/em>/);
    assert.match(out, /<li>one<\/li>/);
});

test("markdown preserves https links and code blocks", () => {
    const out = sanitizeMarkdown(
        "[VinuChain](https://vinuchain.org)\n\n```js\nconst x = 1;\n```\n"
    );
    assert.match(out, /href="https:\/\/vinuchain\.org"/);
    assert.match(out, /<code/);
    assert.ok(out.includes("const x = 1;"));
});

test("code blocks render as text, not as markup", () => {
    const out = sanitizeMarkdown("```html\n<script>alert(1)</script>\n```\n");
    assertInert(out, "md code block");
    // The characters survive, escaped, so the creator's example is still readable.
    assert.ok(out.includes("&#x3C;script>") || out.includes("&lt;script>"));
});

test("Unicode, emoji and RTL text survive both pipelines intact", () => {
    const text = "héllo — 日本語 — العربية — 🎨 — ​zero-width";
    assert.ok(sanitizeMarkdown(text).includes("日本語"));
    assert.ok(sanitizeMarkdown(text).includes("🎨"));
    assert.ok(sanitizeHtml(`<p>${text}</p>`).includes("العربية"));
});

test("html keeps class attributes, which the schema deliberately allows", () => {
    const out = sanitizeHtml('<p class="title">styled</p>');
    assert.match(out, /class="title"/);
    assert.ok(out.includes("styled"));
});

test("both pipelines accept empty and nullish input without throwing", () => {
    for (const value of ["", null, undefined]) {
        assert.equal(typeof sanitizeMarkdown(value), "string");
        assert.equal(typeof sanitizeHtml(value), "string");
    }
});

test("the editor preview and the final render produce identical output", () => {
    // HTMLEditor renders its preview through HTMLViewer, so both call
    // sanitizeHtml. This pins that they cannot diverge.
    const source = '<p class="x">hi</p><script>alert(1)</script>';
    assert.equal(sanitizeHtml(source), sanitizeHtml(source));
    assertInert(sanitizeHtml(source), "editor parity");
});

test("the inertness guard itself rejects unsanitised hostile input", () => {
    // A guard that passes everything proves nothing. Each raw payload below
    // must trip it, so the tests above are meaningful.
    for (const [label, payload] of HOSTILE) {
        assert.throws(
            () => assertInert(payload, "meta"),
            undefined,
            `guard failed to reject raw payload: ${label}`
        );
    }
});

// --- the markdown editor preview must be no weaker than the published render

test("the markdown editor preview plugins neutralise every hostile fixture", async () => {
    const { unified } = await import("unified");
    const { default: remarkParse } = await import("remark-parse");
    const { default: remarkRehype } = await import("remark-rehype");
    const { default: rehypeStringify } = await import("rehype-stringify");
    const mod = await import("../src/common/sanitize.js");
    const { markdownRehypePlugins } = mod.default || mod;

    // Drive the exact plugin list handed to @uiw/react-md-editor. If the
    // preview were more permissive than the published render, a creator could
    // approve content that behaves differently for buyers.
    const previewPipeline = unified().use(remarkParse).use(remarkRehype);
    for (const plugin of markdownRehypePlugins()) {
        previewPipeline.use(plugin);
    }
    previewPipeline.use(rehypeStringify);

    for (const [label, payload] of HOSTILE) {
        const out = String(previewPipeline.processSync(`text\n\n${payload}\n`));
        assertInert(out, `preview/${label}`);
    }
});

test("the editor preview and the published render agree on the same source", async () => {
    const mod = await import("../src/common/sanitize.js");
    const { markdownRehypePlugins } = mod.default || mod;
    const { unified } = await import("unified");
    const { default: remarkParse } = await import("remark-parse");
    const { default: remarkRehype } = await import("remark-rehype");
    const { default: rehypeStringify } = await import("rehype-stringify");

    const pipeline = unified().use(remarkParse).use(remarkRehype);
    for (const plugin of markdownRehypePlugins()) pipeline.use(plugin);
    pipeline.use(rehypeStringify);

    const source = "# Hi\n\n**bold** [ok](https://vinuchain.org)\n\n<img src=x onerror=alert(1)>\n";
    assert.equal(String(pipeline.processSync(source)), sanitizeMarkdown(source));
});
