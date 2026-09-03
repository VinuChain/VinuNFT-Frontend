# Marketplace Discovery

## Strategy

`/marketplace` reads the **index**, not a bounded window. `src/common/indexLoader.js`
scans all three deployed contracts from their verified first blocks
(`config.firstBlocks.v1`) through `eventScan.js`'s cached, chunked, reorg-aware
pass, folds the logs with `src/common/indexer.js`, and hands the page derived
state plus the block that state is current to.

This replaces the earlier client-only MVP, which read `lastTokenId()` and then
only the 12 most recent token ids and the first 5 listing slots per token. Both
bounds hid real listings: `listingCount` is never decremented and `delistToken`
deletes in place, so dead slots accumulate at low indices and the 5-slot cap
preferentially hid the *newest* live listings.

## Data Source

- `eth_getLogs` over the marketplace contract: `TokenListed`, `TokenDelisted`,
  `TokenPurchased`.
- `eth_getLogs` over both NFT contracts: `TransferSingle` and `TransferBatch`.
- `authorOf(tokenId)` once per token ever sighted. Creator is a contract read,
  not an event: neither NFT ABI declares an event carrying one.
- `platformFeePercentage()` on the marketplace and `royaltyInfo(tokenId, remainder)`
  on the NFT, **read at each sale's own block**, plus that sale's receipt.
- `textURI(tokenId)` once per distinct listed text token, for its content type.

The fold is not last-writer-wins over `TokenListed`. `editListing` re-emits
`TokenListed` under the same listing id, a purchase decrements the listed amount
with no `TokenListed` after it, and a delisting zeroes it. `test/indexer.test.mjs`
pins the result against live `listings()`, `listingCount()` and `balanceOf()`
reads for chain 207.

`listingRowsFromIndex(state, formats)` returns rows in the shape the page renders:

```js
{
    nftType: "text" | "image",
    tokenId: number,
    listingId: number,
    seller: string,
    amount: number,          // units listed
    price: string | null,    // PER UNIT, decimal, null if the token is unknown
    priceRaw: string | null, // PER UNIT, base units
    paymentToken: string | null,
    paymentTokenAddress: string,
    sellerBalance: number | null,
    supply: number | null,   // every unit in existence, folded from transfers
    creator: string | null,  // authorOf, a read
    format: string | null,   // MIME from textURI, or "image"
}
```

`price` is **per unit**. `buyToken` charges `price * _amount`
(`Marketplace.sol:211`), so the card states the unit price and the lot total
side by side; a bare price next to "Amount: 3" reads as the cost of the lot and
is off by a factor of three.

`supply` is folded, not read: it is the sum of the token's balances, which is
mints minus burns. It is not the listed amount and costs no extra call.

`sellerBalance` comes from the folded balance map, so it costs no extra call.
This is the right number for fulfillability because `listToken` does not escrow:
it only requires `isApprovedForAll` and writes the listing, and the sole NFT
transfer in the contract is seller to buyer at purchase (`Marketplace.sol:212`).
A scanned token with no entry for the seller holds zero, which is a known
answer, so `null` is unreachable for a rendered row: every rendered row is on a
collection this app scans, and a listable token has a mint transfer. The `null`
branch is defensive only.

## Coverage And Honesty

The page states its coverage in the eyebrow: "Every active listing, indexed from
all marketplace events through block N (M blocks behind the head)". While the
scan runs it says it is indexing; if the scan fails it says the scan failed and
renders no listings at all. A partial index is never presented as complete:
`loadIndex` rejects unless all three contract scans succeed, because publishing
whichever ones finished would be a subset the UI cannot distinguish from the
whole marketplace.

Two classes of listing are handled differently, because `listToken` constrains
neither the payment token nor the collection:

- Priced in an ERC-20 outside `config.tokens`: **rendered without a price**, as
  "unavailable (unrecognised token)" with the ERC-20's address, and counted in
  the coverage line. The listing is real and linkable; only its unit is unknown,
  and stating it in the wrong unit is the one unacceptable option. It is
  excluded from every figure in *Metric Definitions*, including the lowest
  active price.
- On a collection outside `config.contractAddresses.v1`: **counted and
  disclosed, not rendered**. No route links it and no ABI reads it.

The view states the block it is current to and offers a Refresh button. There is
no polling: a page that silently re-renders is a page whose freshness nobody can
reason about.

## RPC Cost

Measured in `test/indexLoader.test.mjs` against the complete chain-207 log
fixture at head 14724734:

- Cold load: **375** `eth_getLogs` (125 ranges of 100000 blocks per contract,
  three contracts), 1 `eth_blockNumber`, **8** `eth_call` and **2**
  `eth_getTransactionReceipt`. The calls are 3 `authorOf` (one per token ever
  sighted), 2 `platformFeePercentage` and 2 `royaltyInfo` (one pair per sale, at
  that sale's block), and 1 `textURI` (one per listed text token).
- Warm load in the same session: **3** `eth_getLogs` — one reorg-rescan range
  per contract — and **0** `eth_call` and **0** receipts, because `eventScan`
  caches each contract's decoded pass while creators, settlements and formats
  are resolved once and kept.

The 100000-block range is bought by the `address` filter. Measured 2026-09-02
on chain 207 and chain 206 alike, the node caps an `eth_getLogs` carrying
neither `address` nor `topics` at 100 blocks, and one carrying either at
100000. The limit is a property of the query, not of the network — a scan that
stopped filtering by contract would still be correct and would cost 125,000
ranges instead of 125. `scripts/verify-deployed-truth.mjs` probes both
boundaries against the live node.

Every one of these is O(sales) or O(listed tokens), not O(blocks): they scale
with what the marketplace did, and the `ponytail:` comments in `indexLoader.js`
name the point at which each wants a multicall or an indexed receipt instead.

Concurrent consumers share one pass: the marketplace and profile routes both
call `loadIndex`, and two simultaneous cold scans would double the cost for
identical data.

`eventScan`'s cache lives for the lifetime of the tab. There is no shared
server-side store and no ingestion independent of a page load; both need a
production host neither repository names.

## Search, Filters, Sort And Paging

`src/common/marketplaceDiscovery.js` is the ONE implementation of "which rows
match, in what order, on what page". It is pure — no provider, no network — so
the page, the tests and any future consumer apply the same predicates. The page
used to re-implement all four predicates and disagreed with the module on an
unknown seller balance.

- **Search** (`filters.query`): an all-digits query matches the token id
  **exactly**; a `0x` query matches the seller address by case-insensitive
  prefix; an empty query filters nothing. A prefix match on ids would answer a
  search for token 1 with 11, 100 and 1000, which is worse than no search.
- **Filters**: NFT type, payment token, fulfillable-only.
- **Fulfillable-only and an unknown balance**: the row is **kept**. An unread
  balance is unknown availability, not a known shortfall, and hiding it would
  shrink the marketplace on the strength of a read that did not happen. The card
  labels it distinctly.
- **Sort** (`compareListingRows`): payment token first, then the raw base-unit
  price, then a deterministic identity. Currencies never interleave, because no
  price oracle exists to order 1 ETH against 100 VINU. Rows with no price sort
  last.
- **Paging** (`pageListings`): `LISTINGS_PAGE_SIZE` rows, bounded by a **cursor**
  (`nftType:tokenId:listingId`) rather than an offset, so a listing arriving
  between renders joins the page it belongs to instead of pushing the last row of
  every page onto the next. An unknown cursor restarts at the top; the page also
  resets the cursor whenever a filter changes.

## Availability

Three states, not two — a seller whose balance is known and short is a settled
fact, and calling it "needs checking" presents it as an open question:

| Condition | Rendered |
| --- | --- |
| `sellerBalance >= amount` | Fulfillable |
| `sellerBalance < amount` | Seller holds only N of M |
| `sellerBalance === null` | Seller balance unavailable |

## Metric Definitions

`src/common/marketplaceAnalytics.js` is a pure fold over the index. It is a
separate module because `test/audit-regressions.test.js` pins that
`marketplaceDiscovery.js` contains no `queryFilter`, and because filtering rows
and measuring a market are different jobs.

**Every money figure is keyed by payment token and is exact.** Coverage is the
complete event history of the deployed marketplace, from its first block
(2232125) to the head block the page names.

| Metric | Exact definition | Source |
| --- | --- | --- |
| Sales | Count of `TokenPurchased` logs. A purchase of 4 units is ONE sale. | events |
| Units sold | `SUM(_amount)`. | events |
| Traded volume | `SUM(_price x _amount)`. `_price` is the PER-UNIT price (`Marketplace.sol:196` reads the listing's unit price, `:211` charges `price * _amount`), so `SUM(_price)` under-reports every multi-unit sale. | events |
| Platform fees | `SUM` of the platform leg of each sale's `settlementBreakdown`, computed from `platformFeePercentage()` read AT THAT SALE'S BLOCK. | reads |
| Creator royalties | `SUM` of the creator leg, from `royaltyInfo(tokenId, remainder)` read AT THAT SALE'S BLOCK, where `remainder` is the total after the platform fee. | reads |
| Seller proceeds | `SUM` of the remaining leg. The three legs sum to the volume exactly. | reads |
| Last sale price | `_price` of the most recent `TokenPurchased` in this token, per unit, with its block. | events |
| Lowest active listing price | The lowest PER-UNIT price among listings active right now in this token. Per unit, not per lot: one unit at 60 is a cheaper way in than three at 50. Listings the seller may not be able to fulfil ARE included — fulfillability is a separate, separately-labelled fact. | events |
| Listings created | Count of distinct `(nftAddress, tokenId, listingId)` triples. NOT the `TokenListed` count: `editListing` re-emits `TokenListed` under the same id, and chain 207 has seven such events carrying two ids. | events |
| Active listings, distinct buyers, distinct sellers | Counts, so currency-free and safe to state globally. | events |

### Why the fee split is read per block, not multiplied

`TokenPurchased` carries no legs, and the deployed marketplace's event set is
`{OwnershipTransferred, Paused, TokenDelisted, TokenListed, TokenPurchased,
Unpaused}` — there is no fee-change event, while `decreasePlatformFeePercentage`
can move the rate at any time. Multiplying volume by today's rate would silently
misreport every sale executed under a different one. The public RPC serves
archive state, so each sale's rate and royalty are read at that sale's own block
and fed to the existing `settlementBreakdown`, which is parity-tested against
128 executed purchases.

Recipient-keyed or positional decoding of the receipt was rejected: in both real
sales all three legs go to the SAME address (`0x12BD…4023` is simultaneously the
seller, the royalty receiver and the commission account), and the positional
form collapses whenever the royalty is zero, since `_handleFunds` then emits two
legs. The receipt is still fetched, but only as an independent CHECK: `legsAgree`
records whether the derived legs reproduce the ERC-20 transfers the buyer paid.

If a sale's historical reads fail, its split is reported unavailable and the
sale still counts toward volume. Nothing is interpolated.

### Reconciliation

`test/marketplaceAnalytics.test.mjs` asserts these figures against the complete
chain-207 fixture and the two real purchase receipts:

| | Receipts | Computed |
| --- | --- | --- |
| Volume | 0.095 + 0.05 + 0.855 + 4.75 + 2.5 + 42.75 = **51.0 WVC** | 51.0 WVC |
| Platform fees | 0.05 + 2.5 | **2.55 WVC** |
| Creator royalties | 0.095 + 4.75 | **4.845 WVC** |
| Seller proceeds | 0.855 + 42.75 | **43.605 WVC** |
| Sales / units / listings created | 2 / 2 / 2 | 2 / 2 / 2 |

### What is deliberately NOT shown

- **No cross-currency aggregate of any kind** — no single volume, no single
  lowest price, no ranking of a WVC listing against a USDT one. This product
  integrates no price oracle (VN-PRICE-001), so any such number would be
  invented. Figures in different ERC-20s are never added or compared.
- **No movement-over-time figure** — no window, no rate of change, no direction
  indicator. It needs a defined window over a sales history the chain does not
  supply.
- **No rarity, no average or median price** — neither has an agreed definition
  here, and both read as authoritative once rendered.
- **No estimate substituted for a failed read.** If a scan fails the page shows
  no listings and no figures at all, rather than a partial view it cannot
  distinguish from a complete one.

## Remaining Gaps

- No shared server-side store and no ingestion off a page load, so the index is
  session-scoped. `serialize`/`deserialize` exist on the indexer but are unwired.
- `/activity/` and `/nft/` still read `history.js` directly rather than the index.
- Settlement resolution is three round trips per sale, resolved on demand. Past
  a few hundred sales the legs want indexing from receipts in the scan itself.
