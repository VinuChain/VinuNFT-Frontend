# VinuNFT

VinuNFT is a Gatsby/React dapp for VinuChain NFTs. It supports text, markdown, and image minting, listings, marketplace discovery, purchases, transfers, burns, address profiles, wallet connection, activity history, WanBridge access, and vault views against VinuChain mainnet.

## Requirements

- Node.js 20
- Yarn 1.x
- A VinuChain-compatible wallet for transaction flows
- A server-side upload endpoint for image NFT IPFS writes

## Install

```bash
git clone https://github.com/VinuChain/VinuNFT-Frontend.git
cd VinuNFT-Frontend
yarn install --frozen-lockfile
```

## Local development

```bash
yarn dev
```

The app is configured for VinuChain mainnet:

- Chain ID: `207`
- Native currency: `VC`
- RPC: `https://rpc.vinuchain.org`
- Explorer: `https://vinuexplorer.org`

Contract addresses and deployment first blocks live in `src/config.js`. When backend contracts are redeployed, update `src/config.js` and the matching ABI files under `src/abis`.

## Environment

Copy `.env.example` into `.env.development` or `.env.production` as needed.

Browser-safe variables:

- `GATSBY_ALCHEMY_API_KEY`
- `GATSBY_ALCHEMY_MAINNET_API_KEY`
- `GATSBY_IPFS_UPLOAD_ENDPOINT`, default `/api/upload-ipfs`

Server-only variables:

- `PINATA_API_JWT`
- `PINATA_ALLOWED_UPLOAD_ADDRESSES`, a comma-separated wallet allowlist for image upload signing
- `PINATA_MAX_UPLOAD_BYTES`
- `PINATA_MAX_UPLOADS_PER_WINDOW`
- `PINATA_MAX_GLOBAL_UPLOADS_PER_WINDOW`
- `TRUSTED_CLIENT_IP_HEADER`, optional, only when your host supplies a trusted client-IP header

Do not expose a Pinata JWT with a `GATSBY_` prefix. Gatsby embeds `GATSBY_*` values into the browser bundle.

## IPFS uploads

Image minting asks the connected wallet to sign an upload intent bound to the
payload digest, the chain, and the action, then posts files and metadata to
`src/api/upload-ipfs.js`. The browser and the function build that message from
one shared module, `src/common/uploadIntent.js`, so they cannot drift apart; a
captured signature authorises only the byte-identical upload it was made for.
A mint signs twice, because the metadata can only be built once the image CID
is known.

The function verifies the signature against the payload it actually received,
requires the signer to be listed in `PINATA_ALLOWED_UPLOAD_ADDRESSES`, applies
per-wallet/IP/global rate limits, enforces the upload size limit, requires file
uploads to be a raster image whose declared media type matches its leading
bytes (`PINATA_ALLOWED_MEDIA_TYPES`; SVG is excluded as script bearing) and
whose declared geometry is under `PINATA_MAX_IMAGE_PIXELS`, and uploads to
Pinata server-side with `PINATA_API_JWT`.

The rate limiter lives in process memory. It resets on cold start and is not
shared between instances, so it is a burst guard on top of the allowlist, not
durable abuse control; see `docs/public-image-minting-access.md`. Static-only hosts must provide an equivalent server endpoint and set `GATSBY_IPFS_UPLOAD_ENDPOINT` to that URL.

The recommended MVP remains allowlist-only. The upload endpoint is intentionally disabled until `PINATA_ALLOWED_UPLOAD_ADDRESSES` is configured. Public image minting requires durable per-wallet, per-IP, and global rate limiting before widening access; do not fake that with process memory. See `docs/public-image-minting-access.md`.

Rotate any Pinata JWT that was previously deployed as `GATSBY_PINATA_API_JWT`; it should be treated as public.

## Social previews

The legacy PHP social-preview route was removed because it fetched user-controlled NFT metadata from the server. NFT pages now build as static Gatsby pages and include safe route-param Helmet tags. Add richer social-preview generation only through a server/indexer path that validates token IDs, uses allowlisted gateways, escapes HTML attributes, and applies network timeouts. See `docs/social-preview-design.md`.

## Marketplace, profiles, and bridge

- `/marketplace` shows active listings from a bounded recent-token client-only window. It is not a global indexer.
- `/address?address=0x...` shows a bounded owned/created NFT profile and keeps an explicit explorer link.
- `/bridge` ports the VinuSwap WanBridge experience into VinuNFT with server-side WanBridge API proxies for token pairs, quota/fee, and transaction creation.

See `docs/marketplace-discovery.md`, `docs/address-profiles.md`, and `docs/vinuswap-bridge-port.md` for scope and limits.

## Verification

```bash
yarn verify:ci
```

`yarn verify:ci` matches the GitHub Actions quality gate:

```bash
yarn lint
yarn test
yarn audit:triage
yarn build
```

`yarn test` runs focused audit-regression checks for the Pinata boundary, public upload docs, marketplace bounds, address profiles, WanBridge routing/proxy validation, removed PHP route, purchase-history token mapping, provider listener cleanup, buy-modal balance rendering, config normalization, bounded event scans, markdown rich-text enablement, and HTML sanitization settings.

`yarn audit:triage` ratchets the current dependency-audit baseline and fails if the vulnerable surface gets worse. See `docs/dependency-audit-triage.md`.

## Deployment

```bash
yarn build
```

Deploy the generated `public/` directory plus the serverless `/api/upload-ipfs` endpoint, or deploy to a platform that supports Gatsby Functions. Ensure `PINATA_API_JWT` exists only in the server runtime environment.
