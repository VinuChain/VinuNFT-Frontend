import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);

const SEED_PAGE = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="script-src 'self'">
</head><body><script>window.x = 1;</script></body></html>`;

/** A throwaway tree with the files add_csp.js reads and both outputs. */
function stagedBuild(mutateVercel = (vercel) => vercel) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinunft-csp-"));
    const vercelStatic = path.join(dir, ".vercel", "output", "static");

    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "public"), { recursive: true });
    fs.mkdirSync(vercelStatic, { recursive: true });
    fs.copyFileSync(
        path.join(repoRoot, "src", "config.js"),
        path.join(dir, "src", "config.js")
    );
    // The enforced frame-ancestors lives here, not in the meta tag, and
    // add_csp.js derives the meta copy from it.
    const vercel = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf-8")
    );
    fs.writeFileSync(
        path.join(dir, "vercel.json"),
        JSON.stringify(mutateVercel(vercel), null, 4)
    );
    fs.writeFileSync(path.join(dir, "public", "index.html"), SEED_PAGE);
    fs.writeFileSync(path.join(vercelStatic, "index.html"), SEED_PAGE);

    return { dir, vercelStatic };
}

test("add_csp expands the policy in the directory Vercel actually ships", () => {
    const { dir, vercelStatic } = stagedBuild();

    try {
        execFileSync("node", [path.join(repoRoot, "add_csp.js")], {
            cwd: dir,
            stdio: "pipe",
        });

        // public/ is the Gatsby output; .vercel/output/static is what the
        // Vercel Gatsby builder serves, and add_csp runs after it is written.
        for (const file of [
            path.join(dir, "public", "index.html"),
            path.join(vercelStatic, "index.html"),
        ]) {
            const html = fs.readFileSync(file, "utf-8");
            assert.match(html, /connect-src 'self' https:\/\//, file);
            assert.match(html, /script-src 'self' 'sha256-/, file);
            assert.equal(
                /content="script-src 'self'"/.test(html),
                false,
                `${file} still carries the unexpanded seed`
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("the meta policy states the frame-ancestors vercel.json enforces", () => {
    // Browsers ignore frame-ancestors in a <meta> element, so the header is the
    // protection and the meta copy is only a description of it. Staging a
    // header the source does not contain is what proves it is read rather than
    // repeated: a hard-coded 'self' would still say 'self' here.
    const { dir, vercelStatic } = stagedBuild((vercel) => {
        vercel.headers[0].headers[0].value = "frame-ancestors 'none'";
        return vercel;
    });

    try {
        execFileSync("node", [path.join(repoRoot, "add_csp.js")], {
            cwd: dir,
            stdio: "pipe",
        });
        for (const file of [
            path.join(dir, "public", "index.html"),
            path.join(vercelStatic, "index.html"),
        ]) {
            const html = fs.readFileSync(file, "utf-8");
            assert.match(html, /frame-ancestors 'none';/, file);
            assert.equal(
                html.includes("frame-ancestors 'self'"),
                false,
                `${file} carries a frame-ancestors the header does not serve`
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a build whose deploy config serves no frame-ancestors header refuses", () => {
    // Deleting the header would otherwise ship a page that still declares
    // frame-ancestors in its meta tag and enforces nothing.
    const { dir } = stagedBuild((vercel) => ({ ...vercel, headers: [] }));

    try {
        assert.throws(
            () =>
                execFileSync("node", [path.join(repoRoot, "add_csp.js")], {
                    cwd: dir,
                    stdio: "pipe",
                }),
            /frame-ancestors response header/
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
