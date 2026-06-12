# Marketplace Discovery

## Recommended MVP

The first release is a client-only MVP. It adds a `/marketplace` route backed by
bounded contract reads from VinuNFT and the marketplace contract. An indexer is
not required for this slice because the page intentionally scans only a recent
window and caps listings per token.

## Data Source

The route uses:

- `lastTokenId()` from the text and image NFT contracts.
- `listingCount(nftAddress, tokenId)` from the marketplace contract.
- `listings(nftAddress, tokenId, listingId)` for only the first capped listing
  IDs per token.
- `balanceOf(seller, tokenId)` from the NFT contract for a fulfillable status.

The adapter returns normalized rows:

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

## Bounded Window

`MARKETPLACE_DISCOVERY_WINDOW` is 12 recent token IDs per NFT type and
`MARKETPLACE_LISTINGS_PER_TOKEN_LIMIT` is 5 listing rows per token. The maximum
RPC call count for the default page is:

- 2 calls for latest token IDs.
- 24 calls for listing counts.
- 120 calls for listing rows.
- Up to 120 calls for seller balances.

Maximum RPC call count: 266 calls before user-applied filtering. The route must
not use `queryFilter` for discovery unless an indexer-backed strategy replaces
this client-only MVP.

## Filters

The first release supports:

- NFT type: all, text, image.
- Payment token.
- Price sort: low to high or high to low.
- Fulfillable-only.
- Seller address.

## Indexer Gaps

Without an indexer the app cannot show every active listing, global historical
volume, full seller inventory, all listing updates, or exact marketplace-wide
ranking. Those require indexed marketplace events and token ownership state.
