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

const result = spawnSync(
    auditCommand.command,
    [...auditCommand.args, "--json", "--groups", "dependencies"],
    {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        shell: auditCommand.shell,
    }
);

const output = `${result.stdout || ""}\n${result.stderr || ""}`;
const metadataLine = output
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

if (!metadataLine) {
    console.error("Could not parse yarn audit summary.");
    if (result.error) {
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
