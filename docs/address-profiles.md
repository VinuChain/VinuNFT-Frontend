# Creator And Address Profiles

## Recommended MVP

Use a bounded client-only profile route: `/address?address=0x...`. The route
validates the address query before reading chain data.

## First Release Sections

- Display name and address.
- External explorer link.
- Owned NFTs in the latest token window.
- Created NFTs in the same latest token window when `authorOf` is available.
- Activity is documented as indexer-first because a useful address-wide feed
  would require event indexing.

## Bounded Strategy

`ADDRESS_PROFILE_WINDOW` is 12 recent token IDs per NFT type. The page reads two
latest token IDs, checks `balanceOf(address, tokenId)` for the recent text/image
windows, and checks `authorOf(tokenId)` in the same window for created NFTs.

Maximum RPC call count: 50 calls for the default owned/created view. The route
must not scan all token IDs or all historical events.

## Indexer Gaps

Full created history, all owned editions, address-wide activity, marketplace
volume, and old transfer history require a future indexer. The profile UI should
remain independent of the eventual data source.
