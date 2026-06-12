# Plan 005: Add Creator And Address Profiles

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not turn this into an unbounded chain scan. When done, update the
> status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a00888a..HEAD -- src/components/Address.js src/common/ens.js src/common/history.js src/pages/vault.js src/pages/nft/index.js src/pages/index.js src/components/NFTCard.js src/components/NFTHistory.js test/audit-regressions.test.js README.md docs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `a00888a`, 2026-06-12

## Why This Matters

The app already displays authors, owners, sellers, buyers, and ENS names, but
address clicks leave VinuNFT for the explorer. Internal creator/address profile
pages would connect existing surfaces: created NFTs, owned NFTs, listings, and
activity. This gives collectors a way to browse a creator or wallet without
leaving the app.

## Current State

- `src/components/Address.js` - every address link goes to the external
  explorer unless `disableLink` is true.
- `src/common/ens.js` - resolves ENS display names.
- `src/pages/vault.js` - can find owned NFTs for the connected wallet by
  scanning recent IDs and checking balances.
- `src/pages/nft/index.js` - displays author, owners, history, and listing
  sellers.
- `src/common/history.js` - parses transfer/list/purchase activity.

Key excerpts:

```js
// src/components/Address.js:13-20
<a
    target="_blank"
    rel="noreferrer"
    href={config.blockExplorer.url + "/address/" + address}
    style={{ textDecoration: "underline" }}
>
    {lookupEns(address) ||
        (shorten ? shortenAddress(address, nChar) : address)}
</a>
```

```js
// src/pages/nft/index.js:744-752
by{" "}
<Address
    address={tokenAuthor}
    shorten
    nChar={8}
/>
```

```js
// src/pages/nft/index.js:881-925
<div className="tabs is-centered is-fullwidth">
    ...
    {isOwners ? (
        <NFTOwners balances={computeBalances(events)} />
    ) : (
        <NFTHistory history={parseHistory(events)} hideId />
    )}
```

```js
// src/pages/vault.js:173-177
const filteredNfts = interleavedNfts.filter(
    ([type, nftId]) =>
        nftToBalance[type][nftId] !== undefined &&
        nftToBalance[type][nftId] !== 0
);
```

Repo conventions to match:

- Page files live under `src/pages/`.
- Address display should keep using `useEns()` where practical.
- NFT grid items should reuse `NFTCard`.
- Avoid live-RPC tests in the default Node test suite.

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

- Design note, for example `docs/address-profiles.md`.
- New page, for example `src/pages/address.js` using query `?address=...`.
- Optional shared bounded ownership lookup helper in `src/common/`.
- `src/components/Address.js` to add internal/external link behavior.
- Optional `src/components/AddressProfileSummary.js`.
- `test/audit-regressions.test.js`.
- README updates if a new route is user-facing.

**Out of scope**:

- Explorer replacement features such as all transactions for an address.
- Unbounded scans over all token IDs or all historical events.
- Backend/indexer implementation unless separately approved.
- Removing external explorer links entirely; the profile page should still offer
  "view on explorer".
- Changing ENS resolution semantics.

## Git Workflow

- Suggested branch: `advisor/005-address-profiles`.
- Commit style in this repo is short sentence case, for example
  `Fixed image scaling on desktop.`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the profile design note

Create `docs/address-profiles.md`. It must define:

- Route shape, for example `/address?address=0x...`.
- First release sections: display name/address, explorer link, owned NFTs window,
  created NFTs if feasible, recent activity if feasible.
- Bounded scanning strategy and maximum RPC calls.
- What requires a future indexer.

**Verify**:
`test -f docs/address-profiles.md && rg -n "route|owned NFTs|created NFTs|activity|bounded|indexer|explorer" docs/address-profiles.md`
-> prints matches for required topics.

### Step 2: Add internal address route only if bounded

If the design note chooses a bounded client-only MVP, create `src/pages/address.js`.
The page must:

- Validate `address` query param before rendering chain data.
- Show a clear invalid-address state.
- Use `<Header />` and `<Helmet><title>Address - VinuNFT</title></Helmet>`.
- Show an external explorer link.
- Use bounded NFT lookups only.

If the design note says an indexer is required, do not create the page.

**Verify**:
`rg -n "Address - VinuNFT|Invalid address|blockExplorer|bounded|NFTCard" src/pages/address.js docs/address-profiles.md`
-> prints route markers, or docs-only rationale.

### Step 3: Update Address links deliberately

If `src/pages/address.js` exists, update `src/components/Address.js` so app
internal address links can navigate to `/address?address=...`, while preserving
an explicit external explorer link on the profile page. Keep `disableLink`
behavior intact.

Do not break places that intentionally disable links, such as NFT cards.

**Verify**:
`rg -n "disableLink|/address\\?address=|blockExplorer.url" src/components/Address.js src/pages/address.js`
-> prints internal route and preserved external explorer link.

### Step 4: Add focused regression checks

Extend `test/audit-regressions.test.js` to assert:

- Profile design note exists.
- If route exists, it validates addresses and has an external explorer link.
- `Address.js` preserves `disableLink`.
- The route or design note documents bounded scanning.

**Verify**:
`yarn test` -> all tests pass, including address profile checks.

### Step 5: Run full gates

Run the full repo verification gates.

**Verify**:

- `yarn lint` -> exit 0.
- `yarn test` -> all tests pass.
- `yarn audit:triage` -> exit 0 unless dependency baseline worsened.
- `yarn build` -> exit 0; existing Gatsby compatibility warnings may remain.

## Test Plan

- Add source-level regression tests in `test/audit-regressions.test.js`.
- Do not add live RPC tests.
- If pure helpers validate addresses or compute bounded ID windows, test those
  directly if importable without Gatsby runtime.

## Done Criteria

All must hold:

- [ ] `docs/address-profiles.md` exists and chooses bounded MVP or indexer-first.
- [ ] If route exists, it validates address query input and provides an explorer
      link.
- [ ] Address link behavior is intentional and `disableLink` still works.
- [ ] New tests cover the route/design and link guardrails.
- [ ] `yarn lint`, `yarn test`, `yarn audit:triage`, and `yarn build` exit 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 005 is updated.

## STOP Conditions

Stop and report back if:

- A useful profile requires unbounded chain scans.
- Created NFTs cannot be identified without scanning all mint events or adding
  an indexer.
- The app needs path parameters that Gatsby static routing cannot support
  without broader routing changes.
- Internal address links would remove needed explorer access.
- The code at the "Current state" excerpts has drifted materially.

## Maintenance Notes

- Profiles are a natural place to later integrate marketplace discovery and
  social previews, but keep this first slice bounded.
- Reviewers should scrutinize query validation and RPC call counts.
- If an indexer is added later, keep profile UI independent from data-source
  details.
