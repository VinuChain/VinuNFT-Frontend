const { spawnSync } = require("node:child_process");
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

const yarnCli = process.env.npm_execpath;
const yarnCliName = yarnCli ? path.basename(yarnCli).toLowerCase() : "";
const auditCommand =
    yarnCliName === "yarn.js" || yarnCliName === "yarnpkg"
        ? { command: process.execPath, args: [yarnCli, "audit"], shell: false }
        : {
              command: process.platform === "win32" ? "yarn.cmd" : "yarn",
              args: ["audit"],
              shell: process.platform === "win32",
          };

// The audit API times out often enough that a single attempt turns a security
// gate into a coin flip. Retried with backoff; a persistent failure is reported
// as a DIFFERENT condition from being over the baseline, because "we could not
// check" and "we checked and it is worse" call for different responses - and it
// still exits non-zero, because a gate that passes when it cannot run is worse
// than no gate.
const ATTEMPTS = 3;
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
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
}

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

const metadataLine = summary;

if (!metadataLine) {
    const text = transcript.join("\n");
    const unreachable =
        /ESOCKETTIMEDOUT|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
            text
        );
    console.error(
        unreachable
            ? `Dependency audit UNAVAILABLE after ${ATTEMPTS} attempts: the registry audit API did not answer. This is not a finding about this repository's dependencies - it means the check did not run.`
            : "Could not parse yarn audit summary."
    );
    if (result?.error) {
        console.error(result.error.message);
    }
    process.exit(1);
}

const vulnerabilities = metadataLine.data.vulnerabilities;
const exceeded = Object.entries(baseline).filter(
    ([severity, allowed]) => vulnerabilities[severity] > allowed
);

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
