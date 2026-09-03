/**
 * Live-state drift detection for the deployed contracts.
 *
 * verify-deployed-truth.mjs proves every zero-arg view is *callable* and throws
 * the answer away, so it verifies shape and never state: pause could flip, the
 * fee could double and the commission account could move with the gate still
 * printing OK. This is the pure half — the values it compares are captured by
 * the reads that gate already performs, so pinning costs no extra RPC call.
 *
 * Pinning is by explicit key: a view is watched only because someone listed it
 * in deployed-invariants.json. Views that legitimately move (lastTokenId on
 * every mint) must never be pinned.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PIN_FILE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "deployed-invariants.json"
);

export function loadPins(file = PIN_FILE) {
    return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * @param actual {name: {codeHash, views: {fn: value}}} as read from chain now.
 * @param pinned the committed file; `_`-prefixed keys are prose, not contracts.
 * @returns one human-readable string per drift, empty when nothing moved.
 */
export function diffInvariants(actual, pinned) {
    const diffs = [];
    for (const [name, pin] of Object.entries(pinned)) {
        if (name.startsWith("_")) continue;
        const live = actual[name];
        if (!live) {
            diffs.push(`${name}: pinned in deployed-invariants.json but no such contract was read`);
            continue;
        }
        if (pin.codeHash && pin.codeHash !== live.codeHash) {
            diffs.push(
                `${name}: deployed bytecode hash changed — pinned ${pin.codeHash}, chain reports ${live.codeHash}`
            );
        }
        for (const [fn, want] of Object.entries(pin.views ?? {})) {
            const got = live.views?.[fn];
            if (got === undefined) {
                diffs.push(`${name}.${fn}: pinned ${want}, but the call no longer answers`);
            } else if (String(got) !== String(want)) {
                diffs.push(`${name}.${fn}: pinned ${want}, chain reports ${got}`);
            }
        }
    }
    return diffs;
}
