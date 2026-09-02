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

- `GATSBY_ALCHEMY_MAINNET_API_KEY`, Ethereum mainnet, ENS reverse lookups only.
  Left empty, ethers 5 falls back to its shared public demo key and ENS names
  stop resolving under real traffic. `https://eth-mainnet.alchemyapi.io` is in
  the CSP `connect-src` for this; an ethers 6 upgrade moves that host.
- `GATSBY_IPFS_UPLOAD_ENDPOINT`, default `/api/upload-ipfs`

Server-only variables:

- `PINATA_API_JWT`
- `PINATA_ALLOWED_UPLOAD_ADDRESSES`, a comma-separated wallet allowlist for image upload signing
- `PINATA_MAX_UPLOAD_BYTES`
- `PINATA_MAX_UPLOADS_PER_WINDOW`
- `PINATA_MAX_GLOBAL_UPLOADS_PER_WINDOW`
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, the durable rate-limit
  store. **Required in every Vercel deployment, preview included**: without them
  the upload endpoint refuses every upload.
- `UPLOAD_RATE_LIMIT_TIMEOUT_MS`, optional, default 2000. Keep it well under the
  function duration limit; a store that cannot answer in time refuses the upload.
- `TRUSTED_CLIENT_IP_HEADER`, optional. Not needed on Vercel: the platform
  overwrites `x-forwarded-for` and does not forward an external one, so it
  cannot be spoofed to mint a fresh per-IP rate-limit bucket. Set it to
  `x-vercel-forwarded-for` if another proxy is ever put in front of Vercel.

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

Rate limits are durable. Per-wallet, per-IP and global fixed windows are counted
with Redis `INCR` over Upstash's HTTPS REST API (`src/common/uploadRateLimit.js`),
one pipelined round trip per upload, so the count survives a cold start, is shared
across instances, and is correct when two invocations race. **It fails closed**:
if the store cannot answer, the upload is refused rather than allowed unlimited.
A refused upload still spends its slot in all three windows — that is the cost of
one round trip, and it is bounded only because the allowlist is checked first.

The in-memory limiter remains as a local-development fallback and cannot be
selected in a deployment: `VERCEL` is set on every Vercel build and invocation,
preview included, and that branch refuses before the fallback is reached.
Static-only hosts must provide an equivalent server endpoint and set
`GATSBY_IPFS_UPLOAD_ENDPOINT` to that URL.

Measured through this handler against the live Pinata API — four uploads, zero
errors, all HTTP 200, and the four test objects unpinned afterwards. Supplied by
the operator who ran it, on or before 2026-09-02; the exact run date was not
recorded, so it is stated as a bound rather than invented:

| payload | round trip |
| --- | --- |
| 1 KB | 1951 ms |
| 256 KB | 2233 ms |
| 2 MB | 6123 ms |
| metadata (JSON) | 1240 ms |

Plus the rate-limit store round trip. These are Pinata's numbers, not this
project's: nothing here can make them faster, and no gate asserts a ceiling on
them, because that would be gating a third party's day. What this project does
control is the *count*, which is what multiplies them, and that is gated — one
Pinata round trip per accepted upload (`test/perf.test.mjs`) and exactly two
uploads per image mint, with a failed mint reusing the pinned CIDs
(`test/journeys.mint.test.mjs`).

An image mint is two separate invocations (image, then metadata), so a typical
mint spends ~3.4s in Pinata and a 2 MB one ~7.4s — but the worst case *per
invocation* is about 6.1s. That per-invocation figure is the one to check
against the Vercel function duration limit on the plan in use, before raising
`PINATA_MAX_UPLOAD_BYTES`.

Re-measuring needs a Pinata credential. This repository has none and must never
contain one; only variable names appear in any file here.

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

`yarn verify:ci` runs the machine-independent part of the GitHub Actions quality
gate:

```bash
yarn lint
yarn test
yarn audit:triage
yarn build
```

`.github/workflows/ci.yml` additionally runs `yarn verify:deployed` before the
build and `yarn verify:csp` then `yarn verify:rendered` after it. Those three
are not folded into `verify:ci`: two need network (a VinuChain RPC, a Chromium
download) and `verify:rendered` must run after `yarn build` against the artifact
it just produced. **`yarn verify:csp` is not optional after a build** — it is
the only gate that catches a policy that no longer matches the bundle it ships
with.

`yarn test` runs focused audit-regression checks for the Pinata boundary, public upload docs, marketplace bounds, address profiles, WanBridge routing/proxy validation, removed PHP route, purchase-history token mapping, provider listener cleanup, buy-modal balance rendering, config normalization, bounded event scans, markdown rich-text enablement, and HTML sanitization settings.

`yarn audit:triage` ratchets the current dependency-audit baseline and fails if the vulnerable surface gets worse. See `docs/dependency-audit-triage.md`.

## Deployment

Production is hosted on **Vercel**, in the VinuChain team's Vercel account.

```bash
yarn build
```

`vercel.json` pins what Vercel cannot infer:

- `framework: "gatsby"`, `installCommand: yarn install --frozen-lockfile`
- `buildCommand: yarn build`, which is `gatsby build` **plus** `node add_csp.js`.
  The default `gatsby build` would ship pages with an unexpanded
  `script-src 'self'` and no working policy.

There is deliberately no `outputDirectory`. Vercel auto-installs
`@vercel/gatsby-plugin-vercel-builder` (do not add it to `gatsby-config.js`
yourself), which runs in `onPostBuild` and writes Build Output API v3 to
`.vercel/output`: `public/` becomes `.vercel/output/static`, and every file in
`src/api/` becomes a Vercel Function under `.vercel/output/functions/api/`.
Setting `outputDirectory` risks the deploy being treated as static-only, which
would drop those functions. `add_csp.js` walks `.vercel/output/static` as well
as `public/`, because it runs after the builder has already written it.

The four server-side endpoints — `/api/upload-ipfs` and the three WanBridge
proxies — therefore run as Vercel Functions with no adapter to configure.
`PINATA_API_JWT` and the Upstash credentials must exist only in the server
runtime environment; never give them a `GATSBY_` prefix.

Node: Gatsby 5 needs Node 20 or newer, and `engines` in `package.json` forbids
23 and above, so Vercel resolves Node 22.

The builder creates API routes with `Promise.allSettled` and never inspects the
results, so a route that fails to build is simply absent from an otherwise green
deployment. `/api/version` answering is what catches that.

### Release state

- **Production branch is `main`.** A push to `main` deploys to production; every
  other branch and pull request gets a preview deployment. The branch is a
  project setting in the Vercel dashboard, not something this repository can
  assert — `scripts/check-production.mjs` is what catches it being wrong.
- **What is live:** `GET /api/version` returns
  `{ commit, ref, environment }`, read from `VERCEL_GIT_COMMIT_SHA`. It answers
  503, not a null commit, when that variable is missing, so a drift check cannot
  silently compare `undefined`.

## Monitoring

`.github/workflows/monitor.yml` runs daily at 07:00 UTC and on demand.

Monitored:

- deployed contract state against pinned invariants (`yarn verify:deployed`)
- IPFS gateway reachability (`scripts/check-gateways.mjs`)
- product journeys against the deployed contracts (`yarn verify:readiness`)
- production uptime, `/api/version` presence, and deployed SHA against the
  branch head (`scripts/check-production.mjs`, using the repository variable
  `VINUNFT_PRODUCTION_URL`). It exits 1 when that variable is unset rather than
  passing quietly. One retry after 60s absorbs a deploy in flight.

Not monitored:

- **Production frontend error volume.** `gatsby-browser.js` reports uncaught
  errors and unhandled rejections to `/api/client-error`, which writes one
  bounded `vinunft.client_error` line to the Vercel runtime log with the release
  SHA. The browser hook reports only in production builds, caps itself at five
  reports per page load, and never sends a query string; the endpoint itself is
  public, so its own guard is the in-memory `applyApiRateLimit` — a burst guard
  per warm instance, not a limit across cold starts. It stores nothing and calls
  no third party, which is why it does not pay for the durable store.
  Its limits, stated plainly: **the Vercel runtime log is short-retention and
  nothing about it alerts anyone.** Reading it means opening the dashboard.
  Turning this into a monitored signal needs a Log Drain or a hosted error
  tracker, which is a paid dependency and a separate decision.
- Real-user performance, and uptime between the daily runs. A daily probe is not
  an uptime monitor; it catches an outage within a day, not within a minute.

### Vercel dashboard steps this repository cannot do

1. Import the project into the VinuChain Vercel account and set the production
   branch to `main`.
2. Turn on **Automatically expose System Environment Variables**. Without it
   `VERCEL_GIT_COMMIT_SHA` is absent at runtime, `/api/version` answers 503, and
   the SHA-drift check reports nothing.
3. Provision Upstash Redis (the Vercel marketplace integration sets both
   variables) and set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
   for production **and** preview. Uploads fail closed until this exists. One
   store serves both: rate-limit keys are namespaced by `VERCEL_ENV`, so a
   preview deployment cannot spend production's global window.
4. Set the server-only Pinata variables, and a fresh `PINATA_API_JWT` — the
   previous one is rotated.
5. Set the repository variable `VINUNFT_PRODUCTION_URL` to the production origin
   (GitHub → Settings → Variables, not Secrets: it is a public hostname).
6. Confirm the function duration limit covers the ~6.1s worst-case Pinata upload
   plus the store round trip; raise it if the plan allows and it does not.
