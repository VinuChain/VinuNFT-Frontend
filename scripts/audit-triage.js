const { spawnSync } = require("node:child_process");
const path = require("node:path");

const baseline = {
    info: 0,
    low: 105,
    moderate: 162,
    high: 235,
    critical: 65,
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
