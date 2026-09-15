const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const triage = require("../scripts/audit-triage.js");

// `yarn audit` without --json prints a human table, so the summary parser finds
// nothing and the gate fails even when the registry answers. --groups
// dependencies is what makes the counts match the committed baseline: without
// it the audit includes devDependencies and returns 37 moderate / 34 high
// against a 32 / 28 ceiling, i.e. a self-inflicted ratchet breach.
test("the primary audit command asks for JSON and for production dependencies", () => {
    const args = triage.auditCommand.args.join(" ");
    assert.match(args, /--json/);
    assert.match(args, /--groups dependencies/);
});

// The fallback must engage on an outage and on nothing else. A broken local
// yarn or an unparseable table is a different problem, and routing it to OSV
// would hide it behind a second opinion.
test("the OSV fallback engages only on an unreachable registry", () => {
    assert.equal(
        triage.registryUnreachable(
            "error Error: https://registry.yarnpkg.com/-/npm/v1/security/audits: ESOCKETTIMEDOUT"
        ),
        true
    );
    assert.equal(triage.registryUnreachable("getaddrinfo EAI_AGAIN"), true);
    assert.equal(
        triage.registryUnreachable(
            "yarn audit v1.22.22\n1 vulnerabilities found - Packages audited: 1653"
        ),
        false
    );
    assert.equal(triage.registryUnreachable("error Command failed."), false);
});

function tree(spec) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinunft-osv-"));
    for (const [relative, contents] of Object.entries(spec)) {
        const file = path.join(dir, relative, "package.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(contents));
    }
    fs.mkdirSync(path.join(dir, ".bin"), { recursive: true });
    return dir;
}

// package.json ranges do not say what is installed; only the tree does. Scoped
// packages sit a directory deeper and nested copies pin their own versions, so
// a walk that misses either under-reports the audited set.
test("the installed set comes from disk, including scoped and nested copies", (t) => {
    const dir = tree({
        lodash: { name: "lodash", version: "4.17.21" },
        "lodash/node_modules/qs": { name: "qs", version: "6.15.3" },
        "@babel/traverse": { name: "@babel/traverse", version: "7.23.0" },
        qs: { name: "qs", version: "6.15.3" },
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // A workspace or `yarn link` dependency is a symlink pointing outside the
    // tree being walked; skipping symlinks would drop real installed code out
    // of the audited set, and only a target that is not reachable any other way
    // can prove it was followed.
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "vinunft-linked-"));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    fs.writeFileSync(
        path.join(external, "package.json"),
        JSON.stringify({ name: "linked-pkg", version: "1.2.3" })
    );
    fs.symlinkSync(external, path.join(dir, "linked-pkg"));

    const installed = triage.collectInstalledPackages(dir);
    const keys = installed.map((p) => `${p.name}@${p.version}`).sort();

    // qs@6.15.3 appears at two paths and counts once: the unit is the installed
    // name@version, not the dependency path.
    assert.deepEqual(keys, [
        "@babel/traverse@7.23.0",
        "linked-pkg@1.2.3",
        "lodash@4.17.21",
        "qs@6.15.3",
    ]);
});

test("an unreadable installed set fails closed", (t) => {
    const dir = tree({ lodash: { name: "lodash" } });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.throws(() => triage.collectInstalledPackages(dir), /lodash/);
    assert.throws(
        () => triage.collectInstalledPackages(path.join(dir, "absent")),
        /absent/
    );
});

function stubOsv({ batches, vulns, seen = [] }) {
    let batch = 0;
    return async (url, init) => {
        seen.push(url);
        if (String(url).endsWith("/querybatch")) {
            JSON.parse(init.body);
            const body = batches[batch];
            batch += 1;
            return { ok: true, status: 200, json: async () => body };
        }
        const id = String(url).split("/").pop();
        if (!(id in vulns))
            return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => vulns[id] };
    };
}

const record = (severity) => ({
    id: "x",
    database_specific: severity === null ? {} : { severity },
});

test("OSV counts one advisory per installed package version", async () => {
    const seen = [];
    const fetchImpl = stubOsv({
        seen,
        batches: [
            {
                results: [
                    { vulns: [{ id: "GHSA-aaa" }, { id: "GHSA-bbb" }] },
                    { vulns: [{ id: "GHSA-aaa" }] },
                    {},
                ],
            },
        ],
        vulns: {
            "GHSA-aaa": record("MODERATE"),
            "GHSA-bbb": record("CRITICAL"),
        },
    });

    const result = await triage.osvAudit({
        packages: [
            { name: "qs", version: "6.15.3" },
            { name: "lodash", version: "4.17.20" },
            { name: "react", version: "18.3.1" },
        ],
        fetchImpl,
    });

    assert.deepEqual(result.counts, {
        low: 0,
        moderate: 2,
        high: 0,
        critical: 1,
    });
    assert.equal(result.packages, 3);
    // Each advisory is fetched once however many packages carry it, or a
    // 1650-package tree turns into thousands of requests.
    assert.equal(seen.filter((u) => u.includes("GHSA-aaa")).length, 1);
});

test("OSV fails closed on anything it cannot resolve", async () => {
    const packages = [{ name: "qs", version: "6.15.3" }];
    const one = (vulns, extra = {}) =>
        triage.osvAudit({
            packages,
            fetchImpl: stubOsv({
                batches: [
                    { results: [{ vulns: [{ id: "GHSA-aaa" }] }], ...extra },
                ],
                vulns,
            }),
            attempts: 1,
        });

    // A paged batch response that we ignore is a silent undercount, which is
    // the one failure mode that looks like success.
    await assert.rejects(
        one({ "GHSA-aaa": record("HIGH") }, { next_page_token: "more" }),
        /page/i
    );
    await assert.rejects(one({ "GHSA-aaa": record(null) }), /GHSA-aaa/);
    await assert.rejects(one({ "GHSA-aaa": record("SEVERE") }), /SEVERE/);
    await assert.rejects(one({ "GHSA-aaa": { id: "x" } }), /GHSA-aaa/);
    await assert.rejects(one({ "GHSA-aaa": record("moderate") }), /moderate/);
    await assert.rejects(one({ "GHSA-aaa": record("MEDIUM") }), /MEDIUM/);
    // A severity that happens to name an Object.prototype member resolves to a
    // function through a plain-object lookup: truthy, so it passes the guard,
    // then lands in a junk bucket and vanishes from the counts.
    await assert.rejects(one({ "GHSA-aaa": record("toString") }), /toString/);
    await assert.rejects(
        one({ "GHSA-aaa": record("constructor") }),
        /constructor/
    );
    await assert.rejects(
        one({ "GHSA-aaa": { ...record("HIGH"), withdrawn: "2026-01-01" } }),
        /withdrawn/i
    );
    await assert.rejects(one({}), /404/);
    await assert.rejects(
        triage.osvAudit({
            packages,
            fetchImpl: async () => {
                throw new Error("ENOTFOUND api.osv.dev");
            },
            attempts: 1,
        }),
        /ENOTFOUND/
    );
    await assert.rejects(
        triage.osvAudit({
            packages: [],
            fetchImpl: stubOsv({ batches: [], vulns: {} }),
        }),
        /no installed packages/i
    );
    // A 200 carrying no advisories at all reads as a clean tree and passes the
    // gate; for a real npm tree that is a degraded answer, not a result.
    await assert.rejects(
        triage.osvAudit({
            packages,
            fetchImpl: stubOsv({ batches: [{ results: [{}] }], vulns: {} }),
            attempts: 1,
        }),
        /no advisories at all/
    );
});

// One batch answering and another failing must not be reported as a complete
// count, and a body that is not JSON is not a result either.
test("a partial or unreadable OSV answer is never reported as a count", async () => {
    const packages = Array.from({ length: 4 }, (_, i) => ({
        name: `p${i}`,
        version: "1.0.0",
    }));
    const firstBatch = { results: [{ vulns: [{ id: "GHSA-aaa" }] }, {}] };
    const secondBatchFails = (second) => {
        let batch = 0;
        return async (url) => {
            if (!String(url).endsWith("/querybatch"))
                return {
                    ok: true,
                    status: 200,
                    json: async () => record("HIGH"),
                };
            batch += 1;
            return batch === 1
                ? { ok: true, status: 200, json: async () => firstBatch }
                : second();
        };
    };

    await assert.rejects(
        triage.osvAudit({
            packages,
            batchSize: 2,
            attempts: 1,
            fetchImpl: secondBatchFails(() => ({
                ok: false,
                status: 500,
                json: async () => ({}),
            })),
        }),
        /500/
    );
    // A truncated or non-JSON body rejects in json(); it must not be treated as
    // an empty page of results.
    await assert.rejects(
        triage.osvAudit({
            packages,
            batchSize: 2,
            attempts: 1,
            fetchImpl: secondBatchFails(() => ({
                ok: true,
                status: 200,
                json: async () => {
                    throw new SyntaxError("Unexpected token < in JSON");
                },
            })),
        }),
        /Unexpected token </
    );
});

// A fake yarn on PATH exercises the whole gate without the network.
function runGate(t, script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinunft-yarn-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "yarn"), `#!/bin/sh\n${script}\n`, {
        mode: 0o755,
    });
    return require("node:child_process").spawnSync(
        process.execPath,
        [path.join(__dirname, "../scripts/audit-triage.js")],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${dir}:${process.env.PATH}`,
                npm_execpath: "",
            },
        }
    );
}

// `undefined > 13` is false for every severity, so a summary whose counts went
// missing clears every ceiling and the gate exits 0 on an empty object. That is
// the exact shape of silent pass this gate exists to prevent.
test("a degraded audit summary fails closed instead of clearing every ceiling", (t) => {
    const run = runGate(
        t,
        `echo '${JSON.stringify({
            type: "auditSummary",
            data: { vulnerabilities: {}, dependencies: 1653 },
        })}'`
    );
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(`${run.stdout}${run.stderr}`, /degraded/i);
    assert.equal(`${run.stdout}${run.stderr}`.includes("OSV"), false);
});

// The fallback is for an outage and nothing else: a local failure must surface
// as itself rather than be answered by a second opinion.
test("a local yarn failure fails as itself and never reaches OSV", (t) => {
    const run = runGate(t, `echo "error Command failed." >&2; exit 1`);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /Could not parse yarn audit summary/);
    assert.equal(`${run.stdout}${run.stderr}`.includes("OSV"), false);
});

// Two sources counting different things must not share one number.
test("the fallback carries its own baseline", () => {
    assert.equal(typeof triage.osvBaseline, "object");
    assert.notEqual(triage.osvBaseline, triage.baseline);
    assert.notDeepEqual(triage.osvBaseline, triage.baseline);
    assert.equal(
        fs
            .readFileSync(
                path.join(__dirname, "../docs/dependency-audit-triage.md"),
                "utf8"
            )
            .includes("OSV"),
        true
    );
});

// The flags above are only worth asserting if the branch they feed still runs.
// A fake yarn on PATH that answers JSON only when asked for it reproduces both
// halves of the 9051370 regression without touching the network.
test("the primary branch passes the gate when the registry answers", (t) => {
    const summary = JSON.stringify({
        type: "auditSummary",
        data: {
            vulnerabilities: triage.baseline,
            dependencies: 1653,
            totalDependencies: 1653,
        },
    });
    const run = runGate(
        t,
        `case "$*" in *--json*) echo '${summary}';; *) echo "1653 packages audited";; esac`
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /"critical":2/);
    // The fallback must not have run: the registry answered.
    assert.equal(run.stdout.includes("OSV"), false);
});
