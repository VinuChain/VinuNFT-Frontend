import { apiRoute } from "./apiRoute";
/**
 * Ships uncaught browser errors to /api/client-error.
 *
 * Production only: in development the console already has the error, and a
 * failing dev build would otherwise spam a log nobody reads. The per-page cap
 * matters because a render loop throws continuously, and an error inside the
 * reporter itself must not re-enter it — a POST failure is swallowed.
 */
const MAX_REPORTS_PER_PAGE_LOAD = 5;

export function reportClientErrors(target) {
    if (process.env.NODE_ENV !== "production") {
        return;
    }

    let reported = 0;
    let sending = false;

    const send = (report) => {
        if (sending || reported >= MAX_REPORTS_PER_PAGE_LOAD) {
            return;
        }

        reported += 1;
        sending = true;
        fetch(apiRoute("client-error"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...report,
                path: target.location?.pathname || null,
            }),
        })
            .catch(() => {})
            .finally(() => {
                sending = false;
            });
    };

    target.addEventListener("error", (event) => {
        send({
            kind: "error",
            message: event.message || String(event.error || "unknown error"),
            source: event.filename || null,
            stack: event.error?.stack || null,
        });
    });

    target.addEventListener("unhandledrejection", (event) => {
        send({
            kind: "unhandledrejection",
            message: String(event.reason?.message || event.reason || "unknown"),
            stack: event.reason?.stack || null,
        });
    });
}
