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
abuse-control system.

## Non-negotiable invariants

- `PINATA_API_JWT` remains server-only and never uses a `GATSBY_` prefix.
  Plain marker for regression tests: PINATA_API_JWT remains server-only.
- Uploads require a recent wallet signature.
- Uploads have a byte limit.
- Uploads have per-wallet and global throttling.
- Error messages are safe to show to users and do not include secrets.

## Rollout

The allowlist MVP can run now by configuring `PINATA_ALLOWED_UPLOAD_ADDRESSES`.
The public model should not roll out until durable rate limit storage is present
and the server can throttle by wallet, IP, and global volume across instances.
