import { sendJson } from "../common/apiRateLimit";

/**
 * The commit this deployment was built from.
 *
 * Vercel injects VERCEL_GIT_COMMIT_SHA at build and invocation time, but only
 * when the project's "Automatically expose System Environment Variables"
 * setting is on. Answering 503 rather than `{ commit: null }` when it is
 * missing is deliberate: a monitor comparing `undefined` to a branch head
 * reports agreement and the drift check silently stops working.
 *
 * This endpoint also proves the API routes deployed at all. The Vercel Gatsby
 * builder creates them with `Promise.allSettled` and never inspects the
 * results, so a route that failed to build is simply absent from an otherwise
 * green deployment.
 */
export default function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    const commit = process.env.VERCEL_GIT_COMMIT_SHA;
    if (!commit) {
        return sendJson(res, 503, {
            error: "VERCEL_GIT_COMMIT_SHA is not present in this runtime.",
        });
    }

    return sendJson(res, 200, {
        commit,
        ref: process.env.VERCEL_GIT_COMMIT_REF || null,
        environment: process.env.VERCEL_ENV || null,
        // The runtime this function actually got, which is not necessarily the
        // one package.json asks for: a Node without global fetch is what broke
        // every proxy here, and nothing in the deployment reported it.
        node: process.version,
        hasFetch: typeof fetch === "function",
        hasGlobalThisFetch: typeof globalThis.fetch === "function",
        // Narrowing why a Node 22 runtime has no fetch. Flags are the project's
        // own configuration, not user data or a secret.
        execArgv: process.execArgv,
        nodeOptions: process.env.NODE_OPTIONS || null,
    });
}
