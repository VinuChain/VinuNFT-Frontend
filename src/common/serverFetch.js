/**
 * `fetch` for code that runs on the server.
 *
 * The deployment sets `NODE_OPTIONS=--no-experimental-fetch`, which removes
 * global fetch even on Node 22 where it is stable. Every server-side request
 * this app makes — the WanBridge proxies and the Pinata upload — therefore
 * failed with "fetch is not defined" before a connection was attempted, which
 * looked exactly like the upstream being unreachable.
 *
 * Removing that variable from the project is the real cleanup, and
 * `/api/version` reports it so it cannot hide again. This exists so the app
 * does not depend on that having been done: undici is the same implementation
 * Node's global fetch is built from, so behaviour is unchanged either way.
 *
 * The import is dynamic and marked webpackIgnore so it is resolved at runtime
 * on the server and never pulled into the browser bundle.
 */
let cached = null;

export async function serverFetch(...args) {
    if (typeof globalThis.fetch === "function") {
        return globalThis.fetch(...args);
    }
    if (!cached) {
        const undici = await import(/* webpackIgnore: true */ "undici");
        cached = undici.fetch ?? undici.default?.fetch;
        if (typeof cached !== "function") {
            throw new Error(
                "serverFetch: no fetch available — global fetch is disabled and undici did not provide one"
            );
        }
    }
    return cached(...args);
}
