# Content policy, reporting and takedown

VinuNFT is a frontend over three immutable contracts on VinuChain. It has no
backend service, no database and no moderation staff. This document states
exactly what can be done about content shown here, what cannot be done by
anyone, and how a report becomes a decision.

## Report content

Public route, and the one to prefer:
[open a content report](https://github.com/VinuChain/VinuNFT-Frontend/issues/new?template=content-report.yml).
The issue tracker is both the intake queue and the audit trail: the report, its
evidence, the decision and the pull request that changes the blocklist all sit
on one public thread that neither side can quietly edit away.

Private route, for legal correspondence or anything that cannot be published:
hello@vitainu.org. A decision reached privately is still recorded here as a
blocklist entry with its reason, category and appeal route.

An actionable report names the collection and token id (or the address), a
category, and evidence. Without evidence a takedown cannot be justified to the
creator, and an unjustifiable takedown is worse than none.

## The five layers, and which of them a takedown reaches

These are different things and are routinely confused. A request to "delete an
NFT" means at most the third and fourth of them.

### Chain data — permanent, out of reach

Token ids, ownership, transfers, listings, sales, royalty settings, and for text
NFTs the content itself (stored as a `data:` URI inside the contract) live in
VinuChain blocks. Nothing in this repository, this deployment, or this
operator's keys can alter or erase a block. No takedown request can achieve it;
neither can a court order, because there is nobody holding a delete button. The
contracts are deployed and immutable — they cannot be patched either. Anyone
running a node, a block explorer or a competing frontend keeps seeing exactly
what was minted.

### Indexed data — none is retained

This app keeps no server-side index and no database. Listings and history are
folded in the browser from logs read live from an RPC node, and that fold lives
only in the visitor's tab. There is therefore no index to purge and no cached
copy of anyone's content held by this project.

### Hosted media — one pin, removable, with limits

The only media this project hosts is what its upload endpoint pinned to Pinata
with the server-held `PINATA_API_JWT`. Image NFTs reference those pins by CID
through an `ipfs://` token URI. Text NFTs reference nothing hosted: their
content is on chain, so for a text NFT there is no hosted media to remove at
all, and a takedown there is frontend suppression and nothing else. See the
procedure below for what unpinning does and does not accomplish.

### Frontend visibility — the part that actually changes

`src/content-blocklist.json` is consulted by this frontend before it renders a
token. An entry can `hide` an item (no media is even fetched, and the page says
it is hidden and why) or `warn` about it (the item stays reachable behind a
stated caution). Suppressed marketplace listings are not offered for sale here,
and the count of suppressed listings is shown so the visible rows and the
published totals cannot silently disagree.

The blocklist changes only by reviewed pull request, so git history is the
audit trail: who added an entry, when, under what category, on what evidence.
It binds this deployment and nothing else. A fork, a local build, a different
frontend, a block explorer or a direct contract read all still show the item.
Hiding something here does not remove it from the chain and is not represented
to anyone as if it had.

### Wallet ownership — untouched

Suppression never moves, freezes or burns a token. The holder still holds it and
can still transfer, list or burn it, from this app or any other client. Only the
owner (or an approved operator) can burn a token, and burning removes the
supply, not the historical record of the mint and the transfers.

## Blocklist entries

Every entry carries, and is validated in CI to carry
(`test/contentSafety.test.mjs`):

| field      | meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `scope`    | `token` or `address`                                            |
| `key`      | `text/12` for a token, or the `0x` address                      |
| `action`   | `hide` or `warn` — the only two things this frontend can do     |
| `category` | illegal, infringing, impersonation, fraud, abuse, malware       |
| `reason`   | shown to the visitor, so it must stand on its own               |
| `evidence` | the report thread, ruling or notice the decision rests on       |
| `addedAt`  | ISO 8601                                                        |
| `appeal`   | how the affected creator gets the decision revisited            |

`hide` outranks `warn` when both match. Address-scoped entries match a creator,
owner or seller; token-scoped entries match one token in one collection.

## Appeals

Reply on the linked evidence thread, or email hello@vitainu.org. An appeal is
answered by a pull request that removes or downgrades the entry, or by a comment
saying why it stands. Because entries are stated in the UI with their category
and reason, a creator can see what they are appealing.

## Takedown procedure for hosted media

Applies to image NFTs whose media was pinned by this project. Requires the
server-held `PINATA_API_JWT` (see `src/api/upload-ipfs.js`); it is not in the
client bundle and only the operator has it.

1. Record the CID. It is the `ipfs://<cid>` in the token's metadata, and the
   metadata URI itself may also be a pinned CID — check both.
2. Unpin each CID from the Pinata account that holds the JWT:
   `curl -X DELETE -H "Authorization: Bearer $PINATA_API_JWT" https://api.pinata.cloud/pinning/unpin/<cid>`
3. Land the blocklist entry in the same change, with the evidence and the
   category. Unpinning without an entry leaves the item rendered here and
   merely broken, which tells a visitor nothing.
4. Reply on the report thread stating what was unpinned and what was hidden.

What unpinning does not achieve, and must never be described as if it did:

- It does not change the token URI. The contract still points at the same CID,
  permanently.
- It does not erase the content from IPFS. A CID is a name for bytes; any
  third-party pin, gateway cache or copy keeps serving it, and this project
  cannot reach those.
- It does not affect the token, its supply, its history or its owner.
- For text NFTs it does nothing at all, because their content was never hosted.

## What an operator still has to do by hand

Judging a report, writing the entry, opening the pull request, unpinning, and
answering the appeal. This product automates none of that, on purpose: at three
collections and this volume, a reviewed file is proportionate and a moderation
service would be a system nobody is staffed to operate.
