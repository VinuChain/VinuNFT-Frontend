# Public Image Minting Access

## Options

### Current Allowlist-only Model

User impact: image minting is limited to configured wallets. Abuse risk is low
because unknown wallets cannot upload. Operational requirements are a Pinata JWT,
`PINATA_ALLOWED_UPLOAD_ADDRESSES`, and the durable rate-limit store below.
Rollout steps: configure the allowlist and monitor upload failures.

### Public Upload With Durable Rate Limiting

User impact: any wallet can mint image NFTs after signing an upload intent.
Abuse risk is medium to high because public file upload can be attacked. The
server needs durable per-wallet and per-IP rate limit storage, global throttling,
observability, and moderation response. Runtime storage requirements are a
shared store such as Redis, database-backed counters, or an edge/WAF limiter.
Rollout steps: provision durable storage, add alerts, stage limits, then remove
the allowlist.

### Public Upload With Abuse-control Gate

User impact: upload access can be opened after the wallet satisfies an explicit
gate such as mint payment proof, captcha, proof-of-work, or another abuse-control
mechanism. Abuse risk depends on the gate. Operational requirements include the
gate provider, replay protection, durable rate limiting, and safe user-facing
errors. Runtime storage requirements are a shared store for attempts and recent
wallet signatures. Rollout steps: ship the gate behind allowlist, audit logs,
then widen gradually.

## Durable rate limiting (in place)

The prerequisite this document named is now met. `src/common/uploadRateLimit.js`
counts per-wallet, per-IP and global fixed windows with Redis `INCR` over
Upstash's HTTPS REST API, one pipelined round trip per upload.

What that buys, precisely:

-   **Shared across instances.** The count lives in the store, so a cold start
    on Vercel no longer restarts every quota from zero.
-   **Correct under concurrency.** `INCR` returns the post-increment count, so
    two invocations racing cannot both see the same "before" value. A
    read-then-write limiter loses increments exactly when it is under attack.
-   **Fails closed.** An unreachable store, a rejected token, a timeout, or an
    unusable answer all refuse the upload. An upload that cannot be counted is
    an upload with no limit, which is worse than a refused one.
-   **Cannot silently degrade in a deployment.** The in-memory path is a
    local-development fallback only; `VERCEL` is set on every Vercel build and
    invocation, preview included, and that branch refuses first.

Two limits are deliberate and must be stated rather than discovered:

-   Windows are fixed, not sliding, so up to 2x a limit can land across a window
    boundary.
-   A refused upload still spends its slot in all three windows, because all
    three are incremented in the one round trip. So a wallet hitting its own cap
    still drains global quota. That is bounded today **only** because
    `assertAllowedUploader` runs before the rate limit, so only an allowlisted
    wallet can spend it. **Widening the allowlist without changing this makes
    the global window trivially exhaustible by one attacker.** Either check the
    per-wallet window in a first round trip before touching global, or give the
    global window its own much larger limit and accept the burn.

## What an upload actually costs

Measured through the real `src/api/upload-ipfs.js` handler against the live
Pinata API, on or before 2026-09-02 (the exact run date was not recorded): 1 KB 1951 ms, 256 KB 2233 ms, 2 MB 6123 ms, metadata
1240 ms. Four uploads, zero errors, all HTTP 200; the four test objects were
unpinned afterwards.

Two consequences for the decisions on this page. First, an accepted upload
holds a serverless invocation open for seconds against a service this project
does not control, so the rate limit is protecting invocation budget as well as
the Pinata plan. Second, a *refused* upload returns in milliseconds but still
spends its slot in all three windows (see above) — so the cheap request is the
one an attacker can issue, and the expensive one is the one a legitimate minter
issues. Widening the allowlist without changing that ordering is what makes the
global window trivially exhaustible.

Re-measuring needs a Pinata credential. There is none in this repository and
there must never be one; only variable names appear in any file here.

## Recommended MVP

Keep the current allowlist-only model for production. Durable rate limiting is
no longer the blocker; the remaining blockers for widening access are the global
quota-burn interaction above, moderation response, and alerting on upload
failures (today they are audit log lines that nobody is paged for).

Payload-bound upload intents (above) are a prerequisite for widening access and
are now in place, but they do not replace durable rate limiting: they stop a
captured signature being reused for *different* content, not a permitted wallet
from uploading repeatedly.

## Non-negotiable invariants

-   `PINATA_API_JWT` remains server-only and never uses a `GATSBY_` prefix.
    Plain marker for regression tests: PINATA_API_JWT remains server-only.
-   Uploads require a recent wallet signature, bound to the payload digest,
    chain, and action (`src/common/uploadIntent.js`, intent version 2). The
    browser and the upload endpoint build the signed message from that one
    module, so they cannot drift apart. A captured signature therefore
    authorises only the byte-for-byte identical upload it was made for;
    re-sending it re-pins identical content to the same CID, which is a no-op.
    Version 1 signed only address and timestamp, so any observer of a single
    signature could pin arbitrary content for the rest of the window. Because
    the image CID is only known after the image is pinned, a mint signs twice:
    once for the image and once for the metadata.
-   Uploads have a byte limit.
-   File uploads are raster images only. The declared media type must be on the
    allowlist (`PINATA_ALLOWED_MEDIA_TYPES`, default PNG/JPEG/GIF/WebP) *and*
    match what the leading bytes actually are (`src/common/imageSniff.js`), so a
    polyglot, a renamed script, or an SVG cannot be pinned as an image. SVG is
    excluded deliberately: it is script bearing, and a gateway serving it
    executes that script on the gateway origin. Declared geometry above
    `PINATA_MAX_IMAGE_PIXELS` is rejected from the header, without decoding.
-   Uploads have per-wallet, per-IP and global throttling, all durable, all
    atomic, and all fail-closed. The per-IP bucket is keyed through
    `clientKey()` in `src/common/apiRateLimit.js`, not `req.socket.remoteAddress`:
    behind a platform proxy the socket address is the proxy and identical for
    every visitor, which collapses the per-IP limit into a second global one.
    That key is only as trustworthy as the header behind it. On Vercel it is
    `x-forwarded-for`, which the platform documents as overwritten and not
    forwarded from an external proxy, specifically to stop IP spoofing — so it
    cannot be rotated by the caller. Put anything else in front of Vercel and
    that stops being true; then set `TRUSTED_CLIENT_IP_HEADER` to
    `x-vercel-forwarded-for`, which the platform sets and a fronting proxy
    cannot overwrite.
-   Buckets are namespaced by `VERCEL_ENV`. Preview deployments share the store
    with production, and without the namespace a wallet testing an upload on a
    pull request would spend production's global window.
-   Error messages are safe to show to users and do not include secrets.
-   Upload attempts emit one structured `vinunft.ipfs_upload` audit event with
    fixed `outcome`, `reason`, `uploadType`, and status fields.
-   Upload audit events may include hashed wallet identifiers and bounded,
    coarse file metadata. They must not include per-IP identifiers, Pinata
    JWTs, wallet signatures, raw IP addresses, uploaded file bytes, metadata
    payloads, or provider response bodies.

## Rollout

The allowlist MVP can run now by configuring `PINATA_ALLOWED_UPLOAD_ADDRESSES`,
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Durable throttling by
wallet, IP and global volume across instances is in place. The public model
should not roll out until the global quota-burn interaction above is addressed
and upload failures alert someone.
