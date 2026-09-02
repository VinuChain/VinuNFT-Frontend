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

/** A throwaway tree with the two files add_csp.js reads and both outputs. */
function stagedBuild() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinunft-csp-"));
    const vercelStatic = path.join(dir, ".vercel", "output", "static");

    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "public"), { recursive: true });
    fs.mkdirSync(vercelStatic, { recursive: true });
    fs.copyFileSync(
        path.join(repoRoot, "src", "config.js"),
        path.join(dir, "src", "config.js")
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
