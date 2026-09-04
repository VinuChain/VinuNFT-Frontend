const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Ratchet, re-set 2026-09-01 after the dependency remediation described in
// docs/dependency-audit-triage.md. Previous ceiling (2026-08-20) was
// low 109, moderate 153, high 252, critical 39 — 553 advisories carried as one
// undifferentiated number.
//
//   critical  39 -> 2    (-37)
//   high     252 -> 28   (-224)
//   moderate 153 -> 28   (-125)
//   low      109 -> 13   (-96)
//   total    553 -> 71   (-482)   packages 2365 -> 1652
//
// Almost all of that is packages that are no longer installed, not packages
// reclassified out of the audited set: of the roots that disappeared, only
// lint-staged (2 advisories) is still on disk as a devDependency. The rest —
// the browser-polyfill roots, sanitize-html, file-loader, gatsby-source-filesystem
// and ws — were uninstalled outright, and the remaining framework roots moved
// forward within their declared ranges.
//
// These are the exact observed counts, so a newly published advisory against a
// package that is still here will fail this gate. That is intended: the answer
// is to re-read docs/dependency-audit-triage.md and decide whether the new
// advisory is reachable, not to raise the number.
const baseline = {
    info: 0,
    low: 13,
    moderate: 32,
    high: 28,
    critical: 2,
};

// Fallback ratchet, established 2026-09-04 by this script's own osvAudit()
// against api.osv.dev over the 1581 name@version pairs installed on disk at
// b5479ab: 38 distinct advisories, 46 units, 11s wall clock. Reproduce with
//   node -e 'const t=require("./scripts/audit-triage.js");
//            t.osvAudit({packages:t.collectInstalledPackages()}).then(r=>console.log(r))'
//
// Deliberately NOT the numbers above, and not comparable to them. yarn counts
// one unit per advisory *path* across the resolved production graph; OSV counts
// one unit per (installed name@version, advisory) across everything on disk,
// dev tooling included. qs is the worked example: yarn reports 4 moderate (two
// GHSAs, each reached by two paths), OSV reports 2 (two GHSAs against the one
// installed version that is vulnerable). See "Two sources, two units" in
// docs/dependency-audit-triage.md before reading one number as the other.
const osvBaseline = {
    low: 5,
    moderate: 22,
    high: 18,
    critical: 1,
};

const yarnCli = process.env.npm_execpath;
const yarnCliName = yarnCli ? path.basename(yarnCli).toLowerCase() : "";
// --json is what emits the auditSummary line this gate parses, and
// --groups dependencies is what makes the counts mean the same thing as the
// baseline above: without it the audit includes devDependencies and reports
// 37 moderate / 34 high against a 32 / 28 ceiling, a ratchet breach invented by
// the gate rather than by the tree.
const auditArgs = ["audit", "--json", "--groups", "dependencies"];
const auditCommand =
    yarnCliName === "yarn.js" || yarnCliName === "yarnpkg"
        ? {
              command: process.execPath,
              args: [yarnCli, ...auditArgs],
              shell: false,
          }
        : {
              command: process.platform === "win32" ? "yarn.cmd" : "yarn",
              args: auditArgs,
              shell: process.platform === "win32",
          };

const ATTEMPTS = 3;

function findAuditSummary(run) {
    const text = `${run.stdout || ""}\n${run.stderr || ""}`;
    return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch (_) {
                return null;
            }
        })
        .find((entry) => entry && entry.type === "auditSummary");
}

// The one condition that earns a second opinion. A yarn that is missing, a
// summary that will not parse, or any other local breakage is a problem with
// this checkout and must surface as itself, not be papered over by OSV.
function registryUnreachable(text) {
    return /ESOCKETTIMEDOUT|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
        text
    );
}

// package.json ranges do not say what is installed, so the fallback reads the
// tree. Keyed by name@version and not by path: a hoisting change or a nested
// duplicate must not move the baseline when no dependency changed.
function collectInstalledPackages(
    root = path.join(__dirname, "..", "node_modules")
) {
    const found = new Map();
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            throw new Error(
                `Cannot read installed packages at ${dir}: ${error.message}`
            );
        }
        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            if (entry.name.startsWith(".")) continue;
            const packageDir = path.join(dir, entry.name);
            // A scope directory holds packages, not a package.
            if (entry.name.startsWith("@")) {
                stack.push(packageDir);
                continue;
            }
            const manifest = path.join(packageDir, "package.json");
            if (fs.existsSync(manifest)) {
                let parsed;
                try {
                    parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
                } catch (error) {
                    throw new Error(
                        `Cannot parse ${manifest}: ${error.message}`
                    );
                }
                if (!parsed.name || !parsed.version) {
                    throw new Error(
                        `${manifest} has no name or no version; the installed set is incomplete.`
                    );
                }
                found.set(`${parsed.name}@${parsed.version}`, {
                    name: parsed.name,
                    version: parsed.version,
                });
            }
            const nested = path.join(packageDir, "node_modules");
            if (fs.existsSync(nested)) stack.push(nested);
        }
    }
    return [...found.values()];
}

const SEVERITIES = {
    LOW: "low",
    MODERATE: "moderate",
    HIGH: "high",
    CRITICAL: "critical",
};
const OSV = "https://api.osv.dev/v1";

async function osvJson(url, init, { fetchImpl, attempts }) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetchImpl(url, {
                ...init,
                signal: AbortSignal.timeout(30000),
            });
            if (!response.ok)
                throw new Error(`${url} answered ${response.status}`);
            return await response.json();
        } catch (error) {
            lastError = error;
            // Immediate retries are one attempt as far as a rate limit or a
            // restarting backend is concerned.
            if (attempt < attempts)
                await new Promise((resolve) =>
                    setTimeout(resolve, 500 * attempt)
                );
        }
    }
    throw new Error(
        `OSV request failed after ${attempts} attempts: ${lastError.message}`
    );
}

// Batched because a per-package query against ~1650 packages is ~1650 round
// trips, and cached per advisory id because one advisory covers many packages.
async function osvAudit({
    packages,
    fetchImpl = globalThis.fetch,
    attempts = ATTEMPTS,
    batchSize = 500,
    concurrency = 8,
}) {
    if (!packages || packages.length === 0) {
        throw new Error("OSV fallback found no installed packages to query.");
    }
    const hits = [];
    for (let start = 0; start < packages.length; start += batchSize) {
        const slice = packages.slice(start, start + batchSize);
        const body = await osvJson(
            `${OSV}/querybatch`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    queries: slice.map((pkg) => ({
                        package: { name: pkg.name, ecosystem: "npm" },
                        version: pkg.version,
                    })),
                }),
            },
            { fetchImpl, attempts }
        );
        const results = body && body.results;
        if (!Array.isArray(results) || results.length !== slice.length) {
            throw new Error(
                `OSV returned ${results ? results.length : "no"} results for ${
                    slice.length
                } queries.`
            );
        }
        // A truncated page silently under-counts, which is the one failure mode
        // that looks like a pass. Refuse it rather than answer from half a set.
        if (
            body.next_page_token ||
            results.some((r) => r && r.next_page_token)
        ) {
            throw new Error(
                "OSV returned a paged querybatch result; the fallback would under-count."
            );
        }
        results.forEach((result, index) => {
            for (const vuln of (result && result.vulns) || []) {
                if (!vuln || !vuln.id) {
                    throw new Error(
                        `OSV returned a vulnerability with no id for ${slice[index].name}.`
                    );
                }
                hits.push({ id: vuln.id, package: slice[index] });
            }
        });
    }

    const ids = [...new Set(hits.map((hit) => hit.id))];
    // Structurally valid empty results are the same shape of fail-open as a
    // paged response: a degraded OSV answers 200 and this tree reads clean.
    if (ids.length === 0) {
        throw new Error(
            `OSV reported no advisories at all across ${packages.length} npm packages; that is a degraded response, not a clean tree. Re-baseline deliberately if the tree really is clean.`
        );
    }
    const severityById = new Map();
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
            while (cursor < ids.length) {
                const id = ids[cursor++];
                const record = await osvJson(
                    `${OSV}/vulns/${encodeURIComponent(id)}`,
                    undefined,
                    { fetchImpl, attempts }
                );
                if (record.withdrawn) {
                    throw new Error(
                        `${id} is withdrawn; decide whether it still counts before trusting this run.`
                    );
                }
                const raw =
                    record.database_specific &&
                    record.database_specific.severity;
                // Own-property lookup only: SEVERITIES["toString"] inherits a
                // function, which is truthy, so a plain lookup would clear the
                // guard below and then vanish into a junk bucket - an advisory
                // dropped from the counts without a word.
                const severity = Object.hasOwn(SEVERITIES, raw)
                    ? SEVERITIES[raw]
                    : undefined;
                if (!severity) {
                    throw new Error(
                        `${id} has severity ${JSON.stringify(
                            raw
                        )}, which is not one of LOW/MODERATE/HIGH/CRITICAL.`
                    );
                }
                severityById.set(id, severity);
            }
        })
    );

    const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
    for (const hit of hits) counts[severityById.get(hit.id)] += 1;
    return { counts, packages: packages.length, advisories: ids.length };
}

function runPrimary() {
    let result;
    let summary = null;
    // Every attempt's output, not just the last one's. A run can time out on the
    // first try and then fail differently on the third, and inspecting only the
    // final attempt threw away the evidence that named the cause - which made this
    // gate report "could not parse" for what was plainly a service outage.
    const transcript = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        result = spawnSync(auditCommand.command, auditCommand.args, {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            shell: auditCommand.shell,
        });
        transcript.push(`${result.stdout || ""}\n${result.stderr || ""}`);
        summary = findAuditSummary(result);
        if (summary) break;
        if (attempt < ATTEMPTS) {
            const waitMs = 3000 * attempt;
            console.error(
                `Audit attempt ${attempt}/${ATTEMPTS} produced no summary; retrying in ${waitMs}ms.`
            );
            Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                waitMs
            );
        }
    }
    return { result, summary, transcript };
}

// Both sources compare through here, so the missing-count check lives here too:
// `undefined > 13` is false, so a result whose counts went missing clears every
// ceiling and reads as a pass. Refuse to compare what is not a number.
function over(counts, ceiling) {
    return Object.entries(ceiling).filter(([severity, allowed]) => {
        const count = counts && counts[severity];
        if (!Number.isFinite(count)) {
            throw new Error(
                `No usable ${severity} count in ${JSON.stringify(
                    counts
                )}: the audit result is degraded, not clean.`
            );
        }
        return count > allowed;
    });
}

// The audit API times out often enough that a single attempt turns a security
// gate into a coin flip. Retried with backoff; a persistent failure is reported
// as a DIFFERENT condition from being over the baseline, because "we could not
// check" and "we checked and it is worse" call for different responses - and a
// failure of BOTH sources still exits non-zero, because a gate that passes when
// it cannot run is worse than no gate.
async function main() {
    const { result, summary, transcript } = runPrimary();

    if (!summary) {
        const text = transcript.join("\n");
        if (!registryUnreachable(text)) {
            console.error("Could not parse yarn audit summary.");
            if (result?.error) console.error(result.error.message);
            process.exit(1);
        }
        console.error(
            `Dependency audit UNAVAILABLE after ${ATTEMPTS} attempts: the registry audit API did not answer. This is not a finding about this repository's dependencies - it means the check did not run.`
        );
        console.error("Falling back to api.osv.dev over the installed tree.");
        const started = Date.now();
        const osv = await osvAudit({ packages: collectInstalledPackages() });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        console.log(
            "SOURCE: OSV.dev fallback - the npm audit API did not answer, so these are NOT the primary npm audit numbers."
        );
        console.log(
            `OSV advisory counts: ${JSON.stringify(osv.counts)} over ${
                osv.packages
            } installed name@version pairs, ${
                osv.advisories
            } distinct advisories, ${seconds}s`
        );
        console.log(
            "Fallback baseline and how its unit differs from yarn's: docs/dependency-audit-triage.md"
        );
        const exceeded = over(osv.counts, osvBaseline);
        if (exceeded.length > 0) {
            console.error(
                `OSV fallback exceeded its baseline: ${exceeded
                    .map(([severity, allowed]) => `${severity} > ${allowed}`)
                    .join(", ")}`
            );
            process.exit(1);
        }
        return;
    }

    const vulnerabilities = summary.data.vulnerabilities;
    const exceeded = over(vulnerabilities, baseline);

    console.log("Dependency audit counts:", JSON.stringify(vulnerabilities));
    console.log("Baseline documented in docs/dependency-audit-triage.md");

    if (exceeded.length > 0) {
        console.error(
            `Dependency audit exceeded baseline: ${exceeded
                .map(([severity, allowed]) => `${severity} > ${allowed}`)
                .join(", ")}`
        );
        process.exit(1);
    }
}

module.exports = {
    auditCommand,
    baseline,
    osvBaseline,
    registryUnreachable,
    collectInstalledPackages,
    osvAudit,
};

if (require.main === module) {
    main().catch((error) => {
        // Fail closed. Deliberately unattributed: over() throws from the primary
        // branch too, and naming the wrong source is exactly what the SOURCE line
        // exists to prevent.
        console.error(`Dependency audit FAILED: ${error.message}`);
        process.exit(1);
    });
}
