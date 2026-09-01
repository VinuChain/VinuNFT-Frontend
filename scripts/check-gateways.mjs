#!/usr/bin/env node
/**
 * IPFS gateway reachability probe for the scheduled monitor.
 *
 * config.ipfsGateways is both the fallback order for resolving ipfs:// URIs
 * and the allowlist of hosts the app will fetch token media from at all, so a
 * dead entry is a live media outage and a CSP connect-src origin pointing at
 * whatever an NXDOMAIN-hijacking resolver hands back.
 *
 * It fetches a real CID rather than resolving DNS: `dns.resolve4` answers for
 * dead hosts on hijacking resolvers, so it goes green on exactly the failure
 * this is meant to catch.
 *
 * Two signals, because they fail differently. DEAD means a transport-level
 * failure on a retry — NXDOMAIN, refused, or a connect timeout against the
 * address a hijacking resolver invented. That is a defect in our own config
 * (the origin is not the project it claims to be) so it exits 1. Anything that
 * answered, or was merely too slow to answer, is reachable and does not: a
 * public gateway returning 429 or 504 for one CID is a bad afternoon, not a
 * config defect, and a monitor that pages on one third party's bad afternoon
 * gets muted. Zero reachable is a media outage and also exits 1.
 *
 * Deliberately NOT wired into verify:deployed: that gate blocks every pull
 * request and must not take a hard dependency on third-party availability.
 *
 * Read-only. Usage: node scripts/check-gateways.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configSrc = readFileSync(resolve(root, "src/config.js"), "utf8");
const listed = configSrc.match(/ipfsGateways:\s*\[([\s\S]*?)\]/);
if (!listed) throw new Error("check-gateways: could not read ipfsGateways from src/config.js");
const gateways = [...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// ImageNFT #1's real media CID: a gateway that serves this serves the app's
// content, which a synthetic well-known CID would not prove.
const CID = "bafkreidiv3wq7rvv4sqsthuu7mqoyf7mmmlocmqo2dogpd6v5hfl42bfoy";
const TIMEOUT_MS = 15000;

export async function probe(gateway) {
    const started = Date.now();
    try {
        const res = await fetch(`${gateway}/${CID}`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await res.body?.cancel();
        return {
            gateway,
            reachable: true,
            served: res.ok,
            detail: `HTTP ${res.status}`,
            ms: Date.now() - started,
        };
    } catch (e) {
        // Our own abort proves slowness, not death; a connect-stage failure
        // (no A record, refused, hijack IP that never completes) proves death.
        const timedOut = e.name === "TimeoutError";
        return {
            gateway,
            reachable: timedOut,
            served: false,
            detail: timedOut
                ? `no answer within ${TIMEOUT_MS}ms (slow, not proven dead)`
                : e.cause?.code ?? e.name ?? String(e),
            ms: Date.now() - started,
        };
    }
}

// One retry before calling an origin dead: a single DNS or connect blip is not
// evidence that a gateway belongs out of the config.
const results = await Promise.all(
    gateways.map(async (g) => {
        const first = await probe(g);
        return first.reachable ? first : probe(g);
    })
);
for (const r of results) {
    const state = r.served ? "served " : r.reachable ? "degraded" : "DEAD    ";
    console.log(`${state} ${r.gateway} — ${r.detail} in ${r.ms}ms`);
}
const reachable = results.filter((r) => r.reachable).length;
const served = results.filter((r) => r.served).length;
console.log(
    `\n${reachable}/${results.length} configured IPFS gateways reachable, ` +
        `${served} served ${CID}`
);
if (reachable === 0) {
    console.error(
        "FAIL: no configured gateway is reachable — every ipfs:// media URI is unresolvable " +
            "and every CSP connect-src gateway origin points at nothing"
    );
    process.exit(1);
}
if (served === 0) {
    console.log(
        "WARN: reachable but nothing served this CID right now — transient at a public " +
            "gateway; if it persists the app cannot show token media"
    );
}
const dead = results.filter((r) => !r.reachable);
if (dead.length) {
    console.error(
        `\nFAIL: ${dead.map((r) => r.gateway).join(", ")} did not answer at all on two ` +
            "attempts. Remove it from config.ipfsGateways: it is a media-fetch allowlist " +
            "entry and a CSP connect-src origin, so on a hijacking resolver it allowlists " +
            "whatever the hijack IP serves, not just a dead fallback."
    );
    process.exit(1);
}
