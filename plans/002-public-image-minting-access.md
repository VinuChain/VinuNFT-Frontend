# Plan 002: Design Public Image Minting Access

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not weaken upload authorization just to make public minting easier.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a00888a..HEAD -- README.md .env.example src/api/upload-ipfs.js src/common/ipfs.js src/common/minting.js src/pages/mint.js src/config.js test/audit-regressions.test.js docs/dependency-audit-triage.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `a00888a`, 2026-06-12

## Why This Matters

Image minting is the default mint mode, but the server upload endpoint is
intentionally disabled until an allowlist is configured. That is a safe
anti-abuse default, but it makes public image minting an operational decision
instead of a designed product path. This plan should produce a clear, secure
access model for public image minting before anyone widens the upload surface.

## Current State

- `src/pages/mint.js` - defaults to image minting and uploads files before mint.
- `src/common/ipfs.js` - signs upload intent and posts base64 file/metadata to
  `config.ipfsUploadEndpoint`.
- `src/api/upload-ipfs.js` - server-side Pinata proxy; requires signed wallet
  intent, an allowlisted address, size limits, and in-memory rate limits.
- `README.md` - explicitly says the upload endpoint is disabled until allowlist
  configuration and requires a production authorization layer for public minting.
- `.env.example` - exposes the current operational knobs.

Key excerpts:

```js
// src/pages/mint.js:29-34
const defaultValues = {
    editionSize: 1,
    royaltyPercentage: 10,
    useCustomRecipient: false,
    dataType: "image",
};
```

```js
// src/common/ipfs.js:12-20
async function createIpfsUploadAuth(walletProvider) {
    const signer = walletProvider.getSigner();
    const address = await signer.getAddress();
    const issuedAt = new Date().toISOString();
    const message = createUploadMessage(address, issuedAt);
    const signature = await signer.signMessage(message);
    return { address, issuedAt, signature };
}
```

```js
// src/api/upload-ipfs.js:97-112
function assertAllowedUploader(address) {
    const allowedAddresses = (envValue("PINATA_ALLOWED_UPLOAD_ADDRESSES") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => ethers.utils.getAddress(value).toLowerCase());
    if (allowedAddresses.length === 0) {
        throw new Error(
            "PINATA_ALLOWED_UPLOAD_ADDRESSES must be configured before uploads are enabled."
        );
    }
    if (!allowedAddresses.includes(address.toLowerCase())) {
        throw new Error("Wallet is not authorized to upload IPFS content.");
    }
}
```

```md
<!-- README.md:58-60 -->
Image minting asks the connected wallet to sign a short upload intent...
The upload endpoint is intentionally disabled until `PINATA_ALLOWED_UPLOAD_ADDRESSES` is configured.
For public minting, put this function behind a production authorization layer with durable rate limiting before widening access.
```

Repo conventions to match:

- Serverless API code currently lives in `src/api/`.
- Environment variables are documented in README and `.env.example`.
- Security invariants are covered by source-level tests in
  `test/audit-regressions.test.js`.
- Never put server-only secrets behind a `GATSBY_` prefix.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---|---|---|
| Use compatible Node | `node --version` | version is `>=18 <23`; README recommends Node 20 |
| Install if needed | `yarn install --frozen-lockfile` | exit 0 |
| Lint | `yarn lint` | exit 0 |
| Tests | `yarn test` | all tests pass |
| Dependency audit ratchet | `yarn audit:triage` | exits 0 unless dependency risk worsened |
| Production build | `yarn build` | exits 0; Gatsby may print existing plugin/dependency warnings |

If the shell default Node is outside `>=18 <23`, use a compatible local Node
before running Yarn, for example `source ~/.nvm/nvm.sh && nvm use 22.22.0`.

## Scope

**In scope**:

- New design note, for example `docs/public-image-minting-access.md`.
- README and `.env.example` updates documenting the chosen access model.
- `src/api/upload-ipfs.js` only if implementing a small proof-of-concept gate
  that keeps or strengthens current safeguards.
- `src/common/ipfs.js` and `src/pages/mint.js` only for user-facing error/help
  text around upload access.
- `test/audit-regressions.test.js` guardrails.

**Out of scope**:

- Removing wallet signatures.
- Removing upload size limits.
- Removing rate limits.
- Making `PINATA_API_JWT` or any server-only secret available to the browser.
- Publicly opening upload access without a durable abuse-control design.
- Migrating to a full new storage provider unless separately approved.

## Git Workflow

- Suggested branch: `advisor/002-public-image-minting-access`.
- Commit style in this repo is short sentence case, for example
  `Fixed image scaling on desktop.`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the access-model design note

Create `docs/public-image-minting-access.md`. It must compare at least three
options:

- Current allowlist-only model.
- Public upload with durable per-wallet and per-IP rate limiting.
- Public upload gated by mint/payment/proof-of-work/captcha or another explicit
  abuse-control mechanism.

For each option, state user impact, abuse risk, operational requirements,
server/runtime storage requirements, and rollout steps.

**Verify**:
`test -f docs/public-image-minting-access.md && rg -n "allowlist|durable|rate limit|wallet|abuse|rollout" docs/public-image-minting-access.md`
-> prints matches for required topics.

### Step 2: Choose an MVP and define non-negotiable invariants

In the design note, mark one option as the recommended MVP. Add a section named
"Non-negotiable invariants" that includes:

- `PINATA_API_JWT` remains server-only.
- Uploads require a recent wallet signature.
- Uploads have a byte limit.
- Uploads have per-wallet and global throttling.
- Error messages are safe to show to users.

Do not edit upload code until the design note states the chosen MVP.

**Verify**:
`rg -n "Recommended MVP|Non-negotiable invariants|PINATA_API_JWT|recent wallet signature|byte limit|global" docs/public-image-minting-access.md`
-> prints all required markers.

### Step 3: Update docs and environment examples

Update README and `.env.example` to describe the chosen model. If the chosen
MVP is still allowlist-only, make that explicit in user-facing operational docs.
If the chosen MVP needs durable storage, document the required storage backend
but do not fake it with process memory.

**Verify**:
`rg -n "public image|allowlist|durable|PINATA_ALLOWED_UPLOAD_ADDRESSES|PINATA_API_JWT" README.md .env.example docs/public-image-minting-access.md`
-> prints the new documentation and existing env knobs.

### Step 4: Optionally implement a small safe gate improvement

Only implement code if the design note identifies a small change that does not
weaken current safeguards, such as clearer errors in `src/pages/mint.js` or a
named upload-mode env var that defaults to the current allowlist-only behavior.

If implementing a server gate, ensure `src/api/upload-ipfs.js` still calls:

- `assertPinataJwt()`
- `assertUploadAuth(...)`
- `assertAllowedUploader(...)` or a stronger replacement
- rate limit checks

**Verify**:
`rg -n "assertPinataJwt|assertUploadAuth|assertAllowedUploader|assertRateLimit|PINATA_API_JWT" src/api/upload-ipfs.js test/audit-regressions.test.js`
-> prints all guardrails, or the design note explains why no code changed.

### Step 5: Add or tighten regression tests

Extend `test/audit-regressions.test.js` so the upload boundary cannot regress.
At minimum, assert:

- `src/api/upload-ipfs.js` still references `PINATA_API_JWT`.
- Client code does not reference `GATSBY_PINATA_API_JWT`.
- A wallet signature is required.
- Public-mode documentation exists.

Pattern after the existing "Pinata credentials stay out of the browser bundle"
test.

**Verify**:
`yarn test` -> all tests pass, including the updated upload-boundary checks.

### Step 6: Run full gates

Run the full repo verification gates.

**Verify**:

- `yarn lint` -> exit 0.
- `yarn test` -> all tests pass.
- `yarn audit:triage` -> exit 0 unless dependency baseline worsened.
- `yarn build` -> exit 0; existing Gatsby compatibility warnings may remain.

## Test Plan

- Extend `test/audit-regressions.test.js` rather than adding network tests.
- Do not call Pinata or live VinuChain RPC from tests.
- If small code changes add pure helper functions, add direct Node tests for
  those helpers only if they can be imported without Gatsby runtime setup.

## Done Criteria

All must hold:

- [ ] `docs/public-image-minting-access.md` exists and names a recommended MVP.
- [ ] The non-negotiable upload invariants are documented.
- [ ] README and `.env.example` match the selected model.
- [ ] Upload guardrail tests pass.
- [ ] `yarn lint`, `yarn test`, `yarn audit:triage`, and `yarn build` exit 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 002 is updated.

## STOP Conditions

Stop and report back if:

- The selected model requires persistent storage, identity verification, captcha,
  or payments that are not available in this repo.
- A requested implementation would remove signatures, allowlist/gating, byte
  limits, or rate limits.
- The implementation would expose a Pinata token or other server secret to the
  browser.
- Product requirements are unclear about who may mint images publicly.
- The code at the "Current state" excerpts has drifted materially.

## Maintenance Notes

- This plan affects the security boundary for user-uploaded content. Human review
  should focus on abuse controls and secret handling before UI copy.
- In-memory rate limits are acceptable only for narrow private/allowlist use.
  Public minting needs a durable strategy or an explicitly accepted operational
  limitation.
- Future social preview work may share allowlisted gateway and upload metadata
  assumptions with this plan.
