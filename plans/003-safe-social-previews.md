# Plan 003: Specify Safe Social Previews For NFT Pages

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not reintroduce the removed PHP route or server-side fetches of
> arbitrary user metadata. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a00888a..HEAD -- README.md postbuild.py static src/pages/nft/index.js src/common/ipfs.js src/common/nftInfo.js src/api test/audit-regressions.test.js docs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M-L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `a00888a`, 2026-06-12

## Why This Matters

NFT pages currently set a basic title but do not provide rich share previews.
The repo removed a legacy PHP social-preview route because it fetched
user-controlled NFT metadata server-side. A safe replacement needs an explicit
server/indexer design with validated token IDs, allowlisted gateways, escaped
metadata, and timeouts before any production implementation.

## Current State

- `README.md` - documents why the old social-preview route was removed and the
  requirements for a future safe path.
- `test/audit-regressions.test.js` - asserts the old PHP route stays removed.
- `src/pages/nft/index.js` - sets only the page title from query params.
- `src/common/ipfs.js` and `src/common/nftInfo.js` - client-side metadata/content
  fetch helpers, not safe server preview infrastructure.

Key excerpts:

```md
<!-- README.md:64-66 -->
## Social previews

The legacy PHP social-preview route was removed because it fetched user-controlled NFT metadata from the server. NFT pages now build as static Gatsby pages. Add social-preview generation only through a server/indexer path that validates token IDs, uses allowlisted gateways, escapes HTML attributes, and applies network timeouts.
```

```js
// test/audit-regressions.test.js:32-38
test("legacy PHP social preview route is removed", () => {
    assert.equal(fs.existsSync(path.join(root, "static/social.php")), false);
    assert.equal(fs.existsSync(path.join(root, "static/Keccak.php")), false);
    assert.equal(read("postbuild.py").includes("index.php"), true);
    assert.equal(read("postbuild.py").includes("file_get_contents"), false);
});
```

```js
// src/pages/nft/index.js:674-679
<Helmet>
    <title>
        {id !== undefined && id !== null
            ? `#${id} - VinuNFT`
            : "VinuNFT"}
    </title>
</Helmet>
```

```js
// src/common/ipfs.js:86-93
async function maybeFetchIpfs(url) {
    if (url.startsWith("ipfs://")) {
        const hash = url.split("ipfs://")[1];
        const response = await fetch(`${config.standardIpfsGateway}/${hash}`);
        return response;
    } else {
        return await fetch(url);
    }
}
```

Repo conventions to match:

- Security-sensitive decisions are documented in README and source-level
  regression tests.
- Gatsby pages use `react-helmet` for metadata.
- Existing API/serverless code lives under `src/api/`.
- Do not reproduce secrets or user-controlled metadata in committed fixtures.

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

- New design note, for example `docs/social-preview-design.md`.
- README updates that point to the safe design.
- Optional `src/api/` prototype only if it validates token type/id, uses
  allowlisted gateways, escapes output, and has timeouts.
- `src/pages/nft/index.js` Helmet metadata only for static, safe tags.
- `test/audit-regressions.test.js` guardrails.

**Out of scope**:

- Recreating `static/social.php` or `static/Keccak.php`.
- Server-side fetching from arbitrary URLs in token metadata.
- Returning raw token metadata as HTML.
- Changing NFT contract metadata format.
- Adding a dependency-heavy image rendering stack without explicit operator
  approval.

## Git Workflow

- Suggested branch: `advisor/003-safe-social-previews`.
- Commit style in this repo is short sentence case, for example
  `Fixed image scaling on desktop.`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the safe-preview design note

Create `docs/social-preview-design.md`. It must define:

- Supported preview inputs: `type` and numeric `id`.
- Allowed data sources: contract reads and allowlisted IPFS gateway only.
- Disallowed data sources: arbitrary metadata URLs and user-supplied gateway URLs.
- Required timeout behavior.
- Required HTML escaping.
- Fallback preview when metadata cannot be fetched safely.
- Whether first implementation is static Helmet tags, serverless endpoint, or
  indexer-generated OG images.

**Verify**:
`test -f docs/social-preview-design.md && rg -n "type|id|allowlisted|timeout|escape|fallback|serverless|indexer" docs/social-preview-design.md`
-> prints matches for all required topics.

### Step 2: Decide the first safe slice

Choose one first slice in the design note:

- Static safe metadata only: add title/description/URL Helmet tags without
  fetching user metadata server-side.
- Serverless metadata endpoint: returns JSON or meta HTML from validated,
  bounded, allowlisted data sources.
- Indexer-generated previews: no app code except docs and links until indexer
  exists.

If the chosen path requires a backend/indexer not present in this repo, STOP
after design and tests documenting the decision.

**Verify**:
`rg -n "First slice|static safe metadata|serverless metadata endpoint|indexer-generated" docs/social-preview-design.md`
-> prints the chosen first slice.

### Step 3: Implement only the selected safe slice

If static metadata is selected, update `src/pages/nft/index.js` to include safe
`og:title`, `og:type`, and `twitter:card` tags based on route query values only.
Do not fetch token metadata server-side.

If a serverless endpoint is selected, create a minimal endpoint under `src/api/`
that validates input and returns safe JSON or escaped metadata. Include explicit
timeouts. Do not fetch arbitrary URLs from token metadata.

If indexer-generated previews are selected, do not implement runtime code.

**Verify**:
`rg -n "og:title|twitter:card|social-preview|timeout|escape|allowlisted" src/pages/nft/index.js src/api docs/social-preview-design.md`
-> prints implementation markers or docs-only rationale.

### Step 4: Strengthen regression tests

Extend `test/audit-regressions.test.js` to assert:

- `static/social.php` and `static/Keccak.php` remain absent.
- `postbuild.py` still does not include `file_get_contents`.
- The new design note exists.
- If code was added, it includes input validation and does not fetch arbitrary
  metadata URLs.

**Verify**:
`yarn test` -> all tests pass, including the social-preview guardrails.

### Step 5: Run full gates

Run the full repo verification gates.

**Verify**:

- `yarn lint` -> exit 0.
- `yarn test` -> all tests pass.
- `yarn audit:triage` -> exit 0 unless dependency baseline worsened.
- `yarn build` -> exit 0; existing Gatsby compatibility warnings may remain.

## Test Plan

- Extend the existing legacy PHP social preview test.
- If an API endpoint is added, add source-level tests for validation and
  disallowed arbitrary fetch patterns unless the endpoint can be tested directly
  without a Gatsby runtime.
- Do not use live IPFS or live RPC in default tests.

## Done Criteria

All must hold:

- [ ] `docs/social-preview-design.md` exists and selects a first safe slice.
- [ ] Legacy PHP preview files remain absent.
- [ ] No server-side arbitrary metadata URL fetch is introduced.
- [ ] If preview code is implemented, validation and timeout behavior are
      present.
- [ ] `yarn lint`, `yarn test`, `yarn audit:triage`, and `yarn build` exit 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 003 is updated.

## STOP Conditions

Stop and report back if:

- The desired preview requires fetching arbitrary user-controlled metadata from
  server-side code.
- The desired implementation needs a new image-rendering service or indexer and
  no such scope is approved.
- Escaping/timeout behavior cannot be made explicit.
- Regression tests would need to be weakened.
- The code at the "Current state" excerpts has drifted materially.

## Maintenance Notes

- Treat social previews as a security-sensitive feature because metadata is
  user-controlled.
- A future indexer can make previews richer and safer by pre-validating content.
- Reviewers should read the generated HTML/JSON path carefully for escaping,
  SSRF-like behavior, timeouts, and gateway allowlisting.
