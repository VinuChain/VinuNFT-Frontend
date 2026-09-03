#!/usr/bin/env node
/**
 * Production liveness and release-drift probe for the scheduled monitor.
 *
 * Three things that only became checkable once the production host was named:
 *
 *   uptime          the site answers at all, and its /api/* routes deployed
 *   deployed SHA    what is live equals the head of the production branch
 *   route presence  /api/version answering proves the Gatsby Functions built;
 *                   the Vercel Gatsby builder creates them with
 *                   Promise.allSettled and never checks the results, so a
 *                   route that failed to build is simply missing from a green
 *                   deployment
 *
 * NOT covered here: production frontend error volume. Browser errors are
 * posted to /api/client-error and land in the Vercel runtime log, which this
 * script cannot query — see README for the retention and alerting limits.
 *
 * An unset VINUNFT_PRODUCTION_URL exits 1 rather than skipping. A monitor that
 * quietly passes when it is not configured is the failure it exists to prevent.
 *
 * Read-only. Usage:
 *   VINUNFT_PRODUCTION_URL=https://... EXPECTED_COMMIT_SHA=$(git rev-parse HEAD) \
 *     node scripts/check-production.mjs
 */
const TIMEOUT_MS = 20000;
// A deploy in flight at probe time is drift that resolves itself. One retry,
// not a polling loop: this runs once a day and a real drift is still drift a
// minute later.
const REDEPLOY_GRACE_MS = 60000;

const siteUrl = process.env.VINUNFT_PRODUCTION_URL?.trim().replace(/\/+$/, "");
const expectedSha = process.env.EXPECTED_COMMIT_SHA?.trim();

if (!siteUrl) {
    console.error(
        "FAIL: VINUNFT_PRODUCTION_URL is not set, so production uptime, deployed SHA and " +
            "API route presence are NOT monitored. Set the repository variable to the " +
            "production origin (the Vercel production domain)."
    );
    process.exit(1);
}
if (!expectedSha) {
    console.error(
        "FAIL: EXPECTED_COMMIT_SHA is not set, so deployed-SHA drift is NOT checked."
    );
    process.exit(1);
}

async function get(path) {
    const started = Date.now();
    try {
        const response = await fetch(`${siteUrl}${path}`, {
            headers: { "Cache-Control": "no-cache" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return {
            status: response.status,
            ms: Date.now() - started,
            body: await response.text(),
        };
    } catch (error) {
        return { status: 0, ms: Date.now() - started, error: error.message };
    }
}

function deployedCommit(result) {
    if (result.status !== 200) {
        return null;
    }
    try {
        return JSON.parse(result.body).commit || null;
    } catch {
        return null;
    }
}

const failures = [];

const page = await get("/");
console.log(
    `GET / -> ${page.status || "no answer"} in ${page.ms}ms${
        page.error ? ` (${page.error})` : ""
    }`
);
if (page.status !== 200) {
    failures.push(`the production site did not serve / (${page.status || page.error})`);
}

let version = await get("/api/version");
let commit = deployedCommit(version);

if (version.status === 503) {
    failures.push(
        "/api/version answered 503: VERCEL_GIT_COMMIT_SHA is absent from the runtime. " +
            "Turn on the project's 'Automatically expose System Environment Variables' " +
            "setting, or deployed-SHA drift cannot be checked at all."
    );
} else if (!commit) {
    failures.push(
        `/api/version did not report a commit (${version.status || version.error}). ` +
            "Either the site is down or the Gatsby Functions did not deploy."
    );
} else if (commit !== expectedSha) {
    console.log(
        `deployed ${commit} != expected ${expectedSha}; re-checking in ${
            REDEPLOY_GRACE_MS / 1000
        }s in case a deploy is in flight`
    );
    await new Promise((resolve) => setTimeout(resolve, REDEPLOY_GRACE_MS));
    version = await get("/api/version");
    commit = deployedCommit(version);
    if (commit !== expectedSha) {
        failures.push(
            `deployed commit ${commit} does not match the production branch head ${expectedSha}`
        );
    }
}

if (failures.length) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(
    `\nOK: ${siteUrl} served / and /api/version, and the live commit is ${commit}.\n` +
        "NOT monitored here: production frontend error volume (posted to /api/client-error, " +
        "readable only in the Vercel runtime log). Contract state: yarn verify:deployed. " +
        "IPFS gateways: scripts/check-gateways.mjs."
);
