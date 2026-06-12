# Plan 001: Add Marketplace Discovery For Active Listings

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise around contract or indexing uncertainty. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a00888a..HEAD -- README.md package.json src/config.js src/common/history.js src/common/abi.js src/common/user.js src/pages/index.js src/pages/nft/index.js src/components/NFTCard.js src/components/Listings.js src/components/Listing.js src/components/FulfillabilityInfo.js test/audit-regressions.test.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `a00888a`, 2026-06-12

## Why This Matters

VinuNFT already supports listing and buying, but discovery is token-first: users
see "Latest NFTs" and must open each NFT before learning whether it is for sale.
The NFT detail page already knows how to read listings, sort them by price, and
surface seller fulfillability. A marketplace discovery surface would make the
existing marketplace behavior visible, reduce buyer friction, and provide a
better entry point for VinuChain NFT trading.

## Current State

- `README.md` - describes listings and purchases as core app capabilities.
- `src/pages/index.js` - homepage lists latest token IDs, not active listings.
- `src/pages/nft/index.js` - detail page fetches listing count and listing rows
  for one token.
- `src/components/Listings.js` and `src/components/Listing.js` - render grouped
  seller listings and buy/edit/delist controls for one token.
- `src/components/FulfillabilityInfo.js` - marks listings that sellers cannot
  currently fulfill.

Key excerpts:

```js
// README.md:3
VinuNFT is a Gatsby/React dapp for VinuChain NFTs. It supports text and image minting, listings, purchases, transfers, burns, wallet connection, activity history, and vault views against VinuChain mainnet.
```

```js
// src/pages/index.js:99-100
<h1 className="title has-text-centered">Latest NFTs</h1>
<InfiniteScroll
```

```js
// src/pages/nft/index.js:541-585
const queryListings = async () => {
    if (!id || !readProvider) return;
    const listingCount = (
        await contract.listingCount(nftAddress, id)
    ).toNumber();
    const newListings = [];
    const promises = [];
    for (let i = 0; i < listingCount; i++) {
        promises.push(
            contract
                .listings(nftAddress, id, i)
                .then((listing) =>
                    newListings.push({
                        amount: listing.amount.toNumber(),
                        price: formatTokenAmount(
                            listing.price,
                            tokenAddressToId[listing.paymentToken]
                        ),
                        paymentToken: listing.paymentToken,
                        seller: listing.seller,
                        id: i,
                    })
                )
        );
    }
    await Promise.all(promises);
    newListings.sort((a, b) => a.price - b.price);
    setListings(newListings);
};
```

```js
// src/components/Listings.js:146-151
<h4 className="title is-4 mt-2">
    {userListingGroup() ? "Other Listings" : "Listings"}
</h4>
{otherListingGroups() !== null ? (
    otherListingGroups().length > 0 ? (
```

Repo conventions to match:

- React components are function components in `.js` files.
- State uses React hooks and Recoil where cross-component state already exists.
- Contract access uses `ethers.Contract`, addresses and ABIs from
  `src/config.js` and `src/common/abi.js`.
- Tests are Node `node:test` regression checks in `test/audit-regressions.test.js`
  that inspect source text for critical guardrails.
- Formatting is 4-space Prettier; lint is ESLint.

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

- New marketplace discovery design note, for example
  `docs/marketplace-discovery.md`.
- Optional new reusable listing discovery module, for example
  `src/common/marketplaceDiscovery.js`.
- Optional new page `src/pages/marketplace.js`.
- Optional header/nav updates in `src/components/Header.js`.
- Optional card/list components under `src/components/`.
- Regression tests in `test/audit-regressions.test.js`.
- README updates if user-facing routes or verification steps change.

**Out of scope**:

- Smart contract changes.
- New backend/indexer service unless this plan is explicitly converted from
  MVP to backend work by the operator.
- Changing listing, buy, edit, delist, transfer, burn, or royalty transaction
  semantics.
- Changing `src/config.js` contract addresses or ABIs.
- Removing existing Latest NFTs behavior unless a replacement is explicitly
  accepted in the design note.

## Git Workflow

- Suggested branch: `advisor/001-marketplace-discovery`.
- Commit style in this repo is short sentence case, for example
  `Fixed image scaling on desktop.`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the discovery design note

Create `docs/marketplace-discovery.md`. It must answer:

- Is the first release a client-only route, an indexer-backed route, or a hybrid?
- Which data source is used for active listings?
- How are listings bounded so the homepage does not issue unbounded RPC calls?
- What filters are supported in the first release: NFT type, payment token,
  price sort, fulfillable-only, seller?
- What cannot be done without an indexer?

Use the current detail-page listing fetch as evidence, but do not copy it blindly
if it would scan too much on the marketplace page.

**Verify**:
`test -f docs/marketplace-discovery.md && rg -n "data source|fulfillable|indexer|client-only|MVP" docs/marketplace-discovery.md`
-> prints matches for all required design topics.

### Step 2: Choose and document a bounded MVP

If a client-only MVP is chosen, constrain it to a bounded window such as the
latest N token IDs per type and explicitly state the maximum RPC call count.
If an indexer is required, STOP after the design note unless the operator
approves backend/indexer work.

For a client-only MVP, add a data adapter that returns normalized listing rows:

```js
{
    nftType: "text" | "image",
    tokenId: number,
    listingId: number,
    seller: string,
    amount: number,
    price: string,
    paymentToken: string,
    sellerBalance: number | null,
}
```

**Verify**:
`rg -n "nftType|tokenId|listingId|sellerBalance|maximum RPC" docs/marketplace-discovery.md src/common src/pages src/components`
-> prints matches in the design note and any implementation files created.

### Step 3: Add the route or stop with a design-only outcome

If the design note selects a client-only MVP, create `src/pages/marketplace.js`
that:

- Uses `<Header />` and `<Helmet><title>Marketplace - VinuNFT</title></Helmet>`.
- Shows active listings only.
- Links each item to `/nft?type=<type>&id=<id>`.
- Shows price, amount, payment token, seller, and a fulfillability indicator.
- Provides loading, empty, and error states.
- Avoids duplicating transaction controls from the NFT detail page unless they
  are extracted into reusable components with tests.

If the design note says an indexer is required, do not create a production page.
Instead, leave a design-only plan with explicit next backend questions.

**Verify**:
`rg -n "Marketplace - VinuNFT|/nft\\?type=|fulfill|No listings|Header" src/pages/marketplace.js docs/marketplace-discovery.md`
-> prints the route markers, or prints the design-only stop rationale.

### Step 4: Add navigation deliberately

If a marketplace route exists, add it to `NAV_LINKS` in `src/components/Header.js`.
If the route is design-only, do not add a dead nav item.

**Verify**:
`rg -n "Marketplace|/marketplace" src/components/Header.js src/pages/marketplace.js docs/marketplace-discovery.md`
-> if a page exists, both Header and page match; if design-only, only docs match.

### Step 5: Add focused regression coverage

Extend `test/audit-regressions.test.js` with source-level checks that prevent
the chosen MVP from drifting into unbounded scans. Pattern it after the existing
tests that inspect `src/pages/index.js`, `src/pages/nft/index.js`, and
`src/common/history.js`.

Minimum checks for client-only MVP:

- Marketplace route exists.
- It uses a documented bound/window.
- It does not call `queryFilter` without a bounded strategy.
- Header links to marketplace.

Minimum checks for design-only outcome:

- The design note exists.
- It records why the route is not implemented without an indexer.

**Verify**:
`yarn test` -> all tests pass, including the new marketplace discovery check.

### Step 6: Run full gates

Run the full repo verification gates.

**Verify**:

- `yarn lint` -> exit 0.
- `yarn test` -> all tests pass.
- `yarn audit:triage` -> exit 0 unless dependency baseline worsened.
- `yarn build` -> exit 0; existing Gatsby compatibility warnings may remain.

## Test Plan

- Add one source-level regression test in `test/audit-regressions.test.js`.
- If a reusable data adapter is added, prefer small pure-function unit tests if
  its filtering/sorting can be isolated without live RPC.
- Do not add live RPC tests to the default suite.

## Done Criteria

All must hold:

- [ ] `docs/marketplace-discovery.md` exists and records the data-source choice.
- [ ] If a page is implemented, `src/pages/marketplace.js` exists and Header
      links to `/marketplace`.
- [ ] If a page is not implemented, the design note explicitly says why and
      lists the backend/indexer questions.
- [ ] Marketplace listing reads are bounded or deferred to an indexer.
- [ ] `yarn lint`, `yarn test`, `yarn audit:triage`, and `yarn build` exit 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 001 is updated.

## STOP Conditions

Stop and report back if:

- The marketplace contract ABI does not expose enough listing data to discover
  active listings without scanning token/listing combinations.
- A client-only route would require unbounded RPC calls over all tokens or all
  historical listing events.
- The operator expects a fully indexed marketplace but no backend/indexer scope
  has been approved.
- Existing listing transaction behavior would need to change.
- The code at the "Current state" excerpts has drifted materially.

## Maintenance Notes

- A future indexer would likely replace the client-only discovery adapter; keep
  UI components separate from data fetching so that swap is cheap.
- Reviewers should scrutinize RPC call count and empty/error states more than
  visual polish.
- Fulfillability is important because the current detail page already surfaces
  unfulfillable listings; the marketplace must not hide that state.
