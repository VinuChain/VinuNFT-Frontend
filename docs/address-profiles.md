# Creator And Address Profiles

## Recommended MVP

`/address?address=0x...` validates the address query, then reads the index built
by `src/common/indexLoader.js` — the same one `/marketplace` reads. It is not a
bounded window.

## First Release Sections

- Display name and address.
- External explorer link.
- Owned NFTs, from the folded balance map.
- Created NFTs, from the stored `authorOf` reads.
- Listed for sale, from the marketplace fold.
- Bought and sold, from the indexed `TokenPurchased` events.

## Index Strategy

The route previously walked the latest 12 token ids per type and read
`balanceOf` and `authorOf` for each. That hid every older token: an address whose
only NFT was token 1 of a thousand looked like it owned nothing, and the page
could not tell that apart from an empty profile.

It now folds every contract log from each contract's verified first block, so
every edition, listing and sale is reachable. The page states the block the
index reached and how far behind the head that is; if the scan fails it says so
rather than rendering an empty profile.

RPC cost is the shared index scan documented in `marketplace-discovery.md`: 375
`eth_getLogs` cold, 3 warm, plus one `authorOf` per token ever sighted.

## Remaining Gaps

Address-wide activity feeds, marketplace volume and per-sale fee history are
indexed in `src/common/indexer.js` but not yet rendered here. Sharing the index
between visitors, and ingesting independently of a page load, need a production
host neither repository names.
