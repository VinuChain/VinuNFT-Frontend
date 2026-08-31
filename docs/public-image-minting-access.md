# Public Image Minting Access

## Options

### Current Allowlist-only Model

User impact: image minting is limited to configured wallets. Abuse risk is low
because unknown wallets cannot upload. Operational requirements are a Pinata JWT
and `PINATA_ALLOWED_UPLOAD_ADDRESSES`. Server/runtime storage requirements are
only process memory for the current per-wallet, per-IP, and global rate limit.
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

## Recommended MVP

Keep the current allowlist-only model for production. Public image minting needs
durable per-wallet and per-IP rate limiting before the upload surface is widened;
the current process-memory limiter is a useful burst guard, not a distributed
abuse-control system. It resets on every cold start and is not shared between
instances, so it must not be described as durable protection.

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
-   Uploads have per-wallet and global throttling.
-   Error messages are safe to show to users and do not include secrets.
-   Upload attempts emit one structured `vinunft.ipfs_upload` audit event with
    fixed `outcome`, `reason`, `uploadType`, and status fields.
-   Upload audit events may include hashed wallet identifiers and bounded,
    coarse file metadata. They must not include per-IP identifiers, Pinata
    JWTs, wallet signatures, raw IP addresses, uploaded file bytes, metadata
    payloads, or provider response bodies.

## Rollout

The allowlist MVP can run now by configuring `PINATA_ALLOWED_UPLOAD_ADDRESSES`.
The public model should not roll out until durable rate limit storage is present
and the server can throttle by wallet, IP, and global volume across instances.
