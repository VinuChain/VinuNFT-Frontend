# Plan 006: Port The VinuSwap WanBridge Experience Into VinuNFT

Executor: read this file fully before editing. This plan replaces the old
"decide whether the bridge exists" direction. The product decision is now: copy
the VinuSwap bridge approach, adapt it to VinuNFT, and add contextual bridge
shortcuts near payment-token UX.

Planned-at commit: `a00888a`
Priority: P1
Effort: L
Risk: MED-HIGH
Status: DONE

## Drift Check

Before editing, run:

```bash
git status --short
git rev-parse --short HEAD
git diff -- src/pages/bridge.js src/components/Header.js src/components/BuyModal.js src/components/ListModal.js src/config.js src/common/provider.js src/api test/audit-regressions.test.js
git -C /home/gypsey/VinuSwap-Frontend status --short
git -C /home/gypsey/VinuSwap-Frontend rev-parse --short HEAD
```

If any target VinuNFT source file already has bridge work, merge with it instead
of replacing it. If the VinuSwap bridge implementation has moved, find the new
files before continuing.

## Why

`src/pages/bridge.js` currently shows a generic Li.Fi iframe aimed from Ethereum
to Polygon and warns that VinuNFT is not affiliated with Li.Finance. It is not
linked from the header and does not help NFT buyers bridge the tokens they need
onto VinuChain.

VinuSwap already has the desired model: a first-party `/bridge` page powered by
WanBridge, VinuChain route discovery, quota/fee lookup, transaction creation,
wallet chain switching, allowance handling, and small "Bridge" shortcuts near
token-balance areas. VinuNFT should port that product surface instead of
maintaining a hidden third-party iframe.

## Current State

- VinuNFT bridge page: `src/pages/bridge.js` is a simple Li.Fi iframe with
  `https://li.finance/embed?...toChain=pol...` and no VinuChain-specific route
  discovery.
- VinuNFT header: `src/components/Header.js` has `Home`, `Mint`, and `Activity`;
  `Vault` is conditional on wallet connection; there is no visible `Bridge` nav.
- VinuNFT token config: `src/config.js` already has VinuChain mainnet
  `chainId: 207`, RPC `https://rpc.vinuchain.org`, VinuScan explorer
  `https://mainnet.vinuscan.com`, and marketplace payment tokens `WVC`, `USDT`,
  `VINU`, and `ETH`.
- VinuNFT buyer flow: `src/components/BuyModal.js` has payment-token total,
  balance, and insufficient-balance states where a bridge shortcut belongs.
- VinuNFT listing flow: `src/components/ListModal.js` has a payment-token
  selector and price input. A quieter bridge shortcut can help sellers understand
  where buyers can source the selected payment token.
- VinuSwap source implementation to port:
  - `/home/gypsey/VinuSwap-Frontend/src/common/wanbridge.ts`
  - `/home/gypsey/VinuSwap-Frontend/src/common/wanbridgeValidation.ts`
  - `/home/gypsey/VinuSwap-Frontend/src/pages/api/wanbridge/token-pairs.ts`
  - `/home/gypsey/VinuSwap-Frontend/src/pages/api/wanbridge/quota-and-fee.ts`
  - `/home/gypsey/VinuSwap-Frontend/src/pages/api/wanbridge/create-tx.ts`
  - `/home/gypsey/VinuSwap-Frontend/src/pages/bridge.tsx`
  - `/home/gypsey/VinuSwap-Frontend/src/components/walletBalances/index.tsx`
  - `/home/gypsey/VinuSwap-Frontend/src/pages/index.tsx`
  - `/home/gypsey/VinuSwap-Frontend/src/Routes.tsx`
  - `/home/gypsey/VinuSwap-Frontend/scripts/test-wanbridge-model.mjs`
  - `/home/gypsey/VinuSwap-Frontend/src/common/wanbridgeValidation.test.ts`
- Architecture mismatch to respect: VinuSwap is Next/TypeScript/styled
  components with ethers v6 and newer wallet tooling. VinuNFT is Gatsby/React
  JavaScript with Bulma/current global CSS, Gatsby Functions under `src/api`,
  ethers v5, and Web3Modal v1. Port the behavior and UX; do not blindly paste
  TypeScript or Next API code.

## Commands

Use these to inspect the source implementation while working:

```bash
git -C /home/gypsey/VinuSwap-Frontend grep -n "WANBRIDGE_API_BASE\|WANBRIDGE_PARTNER\|VINUCHAIN_CHAIN_TYPE\|buildVinuChainRoutes\|isAmountWithinQuota" -- src/common/wanbridge.ts
git -C /home/gypsey/VinuSwap-Frontend grep -n "wanbridge/token-pairs\|quota-and-fee\|create-tx\|wallet_switchEthereumChain\|Bridge with WanBridge\|Open WanBridge" -- src/pages/bridge.tsx
git -C /home/gypsey/VinuSwap-Frontend grep -n "BridgeShortcut\|Need tokens" -- src/components/walletBalances/index.tsx src/pages/index.tsx
```

Use these VinuNFT verification gates after implementation:

```bash
yarn lint
yarn test
yarn audit:triage
yarn build
```

## Scope

In scope:

- Replace the Li.Fi iframe bridge with a VinuNFT-native WanBridge page.
- Port VinuSwap's WanBridge route model, validation, quota lookup, and
  transaction creation behavior into JavaScript modules compatible with this
  Gatsby app.
- Add Gatsby Function API proxies for WanBridge catalog, quota/fee, and
  transaction creation with caching, validation, and rate limiting.
- Add `Bridge` to the main header nav as a first-class route.
- Add a reusable bridge shortcut component and wire it next to payment-token
  touchpoints:
  - `BuyModal`: near the payment-token balance and insufficient-balance notice.
  - `ListModal`: near the payment-token selector or price label, using softer
    copy than the buyer shortage state.
  - Optional wallet/vault empty states if they mention token balances.
- Support contextual links such as `/bridge?token=USDT&direction=into` so token
  UI can preselect the relevant bridge asset when possible.
- Preserve VinuNFT's current styling conventions. Prefer existing Bulma classes
  plus `src/styles/globals.css` additions over adding a styling dependency.
- Add regression tests that protect the bridge route and shortcut integrations.

Out of scope:

- Marketplace contract changes.
- Custodial bridge logic or a new bridge provider.
- Removing existing NFT mint/list/buy behavior.
- Replacing VinuNFT's wallet stack with VinuSwap's wallet stack.
- Shipping unvalidated direct browser calls to WanBridge for transaction
  creation.

## Git Workflow

1. Create a focused branch, for example:

   ```bash
   git checkout -b port-vinuswap-bridge
   ```

2. Keep bridge model/API/page work separate from small UI shortcut wiring if
   that makes review easier.
3. Update this plan's status and the row in `plans/README.md` before handoff.
4. Do not commit unrelated changes already present in the working tree.

## Steps

### 1. Document the port map

Create a short implementation note, for example
`docs/vinuswap-bridge-port.md`, before editing the bridge page. Include:

- VinuSwap files copied from.
- VinuNFT replacement files created or changed.
- Differences forced by Gatsby, JavaScript, ethers v5, Web3Modal v1, and Bulma.
- WanBridge partner value decision.

Use `WANBRIDGE_PARTNER = "VinuNFT"` unless WanBridge requires an already
registered partner string. If the partner value must stay `"VinuSwap"` for
upstream accounting or access, stop and ask before shipping.

### 2. Port the WanBridge model and validation

Create VinuNFT JavaScript equivalents of VinuSwap's:

- `src/common/wanbridge.ts`
- `src/common/wanbridgeValidation.ts`

Recommended VinuNFT targets:

- `src/common/wanbridge.js`
- `src/common/wanbridgeValidation.js`

Requirements:

- Keep `WANBRIDGE_API_BASE = "https://bridge-api.wanchain.org/api"`.
- Keep `WANBRIDGE_WEB_URL = "https://bridge.wanchain.org/"`.
- Use `VINUCHAIN_CHAIN_TYPE = "VC"`.
- Prioritize VinuChain routes for `USDT`, `VINU`, and `VC`.
- Use VinuNFT's `src/config.js` for VinuChain chain metadata:
  - chain ID `207`
  - RPC `https://rpc.vinuchain.org`
  - explorer `https://mainnet.vinuscan.com`
  - native symbol `VC`
- Preserve route fields needed by the UI:
  - `tokenPairID`
  - `symbol`
  - `direction`
  - `fromChain`
  - `toChain`
  - `fromToken`
  - `toToken`
  - `vcToken`
  - `remoteChain`
  - `remoteToken`
  - `supportsInAppSigning`
  - `targetNeedsCustomAddress`
- Preserve quota math. Use ethers v5 `BigNumber` or the existing project
  decimal helpers; do not compare human decimal strings directly.

### 3. Add Gatsby Function WanBridge proxies

Port the VinuSwap API route behavior into Gatsby Functions. Confirm Gatsby route
filenames before implementation, then use stable client paths such as:

- `/api/wanbridge-token-pairs`
- `/api/wanbridge-quota-and-fee`
- `/api/wanbridge-create-tx`

If Gatsby supports the nested route shape cleanly in this project, using
`/api/wanbridge/token-pairs`, `/api/wanbridge/quota-and-fee`, and
`/api/wanbridge/create-tx` is also acceptable. Pick one shape and document it in
the port note.

Requirements:

- Token-pairs proxy:
  - `GET` only.
  - Fetch `tokenPairsHash` and `tokenPairs`.
  - Filter to pairs where either side has chain type `VC`.
  - Return `hash`, `fetchedAt`, `pairs`, and `routes`.
  - Cache for roughly 5 minutes and send appropriate `Cache-Control`.
- Quota/fee proxy:
  - `GET` only.
  - Require `fromChainType`, `toChainType`, `tokenPairID`, and `symbol`.
  - Forward to WanBridge `quotaAndFee`.
  - Cache successful responses briefly, around 30 seconds.
- Create-tx proxy:
  - `POST` only.
  - Require and validate `fromChain`, `toChain`, `fromToken`, `toToken`,
    `fromAccount`, `toAccount`, and `amount`.
  - Validate source EVM address with ethers v5
    `ethers.utils.isAddress`.
  - Validate destination account based on chain type.
  - Validate token identifiers and positive decimal amount.
  - Add `partner`.
  - Forward to WanBridge `createTx2`.
- Rate-limit all three endpoints. You may extract a small shared
  `src/api` helper or mirror the in-memory pattern already used by
  `src/api/upload-ipfs.js`.

### 4. Replace the bridge page

Replace `src/pages/bridge.js` with a real WanBridge experience adapted from
VinuSwap's `src/pages/bridge.tsx`.

Required UX:

- Page metadata title and description specific to VinuNFT.
- Hero copy that clearly says this bridges assets into or out of VinuChain for
  NFT minting, listing, and buying.
- Featured route buttons for high-priority routes when available.
- Direction control for `Into VinuChain` and `Out of VinuChain`.
- Token selector and network selector.
- Amount input.
- Destination address input that auto-fills the connected wallet when the
  target chain is EVM-compatible.
- Live quota/fee/limit panel.
- Route notes that explain when in-app signing is supported and when users must
  continue in the official WanBridge app.
- Primary action states equivalent to VinuSwap:
  - loading routes
  - connect wallet
  - open WanBridge
  - bridge transaction running
  - bridge with WanBridge
- Transaction preview after a bridge transaction is created or sent.
- Explicit fallback link to the official WanBridge app.
- Mobile-safe layout with no overflowing selector text.

Do not keep the Li.Fi iframe or "not affiliated with Li.Finance" note.

### 5. Adapt wallet and transaction handling

Use VinuNFT's existing wallet provider from `src/common/provider.js`.

Requirements:

- Use ethers v5 APIs:
  - `new ethers.providers.Web3Provider(...)` only if needed for raw injected
    providers.
  - `walletProvider.getSigner()`
  - `ethers.Contract`
  - `ethers.BigNumber`
  - `ethers.utils.isAddress`
- For chain switching, call `wallet_switchEthereumChain` and
  `wallet_addEthereumChain` through the underlying provider request API when
  available. Use VinuNFT config for VinuChain metadata.
- If the current Web3Modal v1 provider cannot expose `request`, stop and record
  the smallest adapter needed before continuing.
- Preserve VinuSwap's safety behavior:
  - validate amount against quota before creating a transaction.
  - check and request allowance when WanBridge returns `approveCheck`.
  - reset non-zero allowance to zero first if required by token behavior.
  - send the bridge transaction with the exact `to`, `data`, and `value`
    returned by WanBridge.

### 6. Add first-class navigation

Update `src/components/Header.js`:

- Add `Bridge` to `NAV_LINKS`.
- Keep `Vault` conditional behavior unchanged.
- Verify the mobile burger and desktop layout still fit after adding one nav
  item.

### 7. Add contextual bridge shortcuts

Create a small reusable component, for example `src/components/BridgeShortcut.js`.

Expected behavior:

- Renders as a compact link/button to `/bridge`.
- Accepts optional `token`, `direction`, and `variant` props.
- Encodes token context in query params when available.
- Has accessible text or `aria-label`, not icon-only mystery UI.
- Uses existing button/link styling and new global CSS only as needed.

Wire it into:

- `BuyModal`:
  - Show near `Your balance` when a payment token is selected.
  - Emphasize it in the insufficient-balance notification:
    "Insufficient balance. Bridge USDT to VinuChain" or equivalent concise copy.
  - Use the selected `paymentToken` symbol in the link context.
- `ListModal`:
  - Show beside or under the payment-token selector with quiet copy such as
    "Buyers can bridge this token to VinuChain".
  - Use the selected `paymentToken` symbol in the link context.
- Optional:
  - Vault or wallet empty states where the page is already discussing token
    balances.

Do not add bridge CTAs beside text NFT body fields, image upload controls,
royalty percentage fields, or any input that is not actually about a payment
token.

### 8. Add regression coverage

Extend `test/audit-regressions.test.js` or add a focused source-level test.

Cover at least:

- `src/pages/bridge.js` no longer contains `li.finance`.
- The bridge page fetches the chosen VinuNFT WanBridge API paths.
- The bridge page references WanBridge, VinuChain direction controls, quota/fee,
  and transaction creation behavior.
- Header nav includes `/bridge`.
- `BuyModal` includes a bridge shortcut near payment-token balance or
  insufficient-balance UI.
- `ListModal` includes a bridge shortcut near the payment-token selector.
- WanBridge validation rejects missing fields, invalid chain types, invalid EVM
  source addresses, invalid token identifiers, and non-positive amounts.

If source-level tests become too brittle for the bridge page, extract the
route-building and validation logic and test those helpers directly.

### 9. Manual UX pass

Run a local Gatsby dev server and inspect at least:

- `/bridge` disconnected.
- `/bridge` connected to VinuChain.
- `/bridge` with a token query param, for example `/bridge?token=USDT`.
- Buy modal with enough balance.
- Buy modal with insufficient balance.
- List modal payment-token selector.
- Header desktop width around 1280px.
- Header mobile width around 390px.

Confirm there is no text overlap, no selector clipping, no nested card-heavy
layout, and no hidden primary action below the fold on mobile.

## Test Plan

Automated:

```bash
yarn lint
yarn test
yarn audit:triage
yarn build
```

Manual:

```bash
yarn start
```

Then open the routes and modals listed in "Manual UX pass".

Optional if WanBridge behavior is hard to verify from the browser:

```bash
node scripts/test-wanbridge-model.mjs
```

Only add this script if it is ported to VinuNFT and does not require secrets.

## Done Criteria

- `/bridge` is a WanBridge/VinuChain page, not a Li.Fi iframe.
- The page can load VinuChain WanBridge routes through VinuNFT API proxies.
- In-app signing works for supported EVM source routes, or unsupported routes
  clearly open the official WanBridge app.
- Header includes a `Bridge` nav item on desktop and mobile.
- Buyer payment-token balance and insufficient-balance UI offer a contextual
  bridge shortcut.
- Listing payment-token selector offers a quiet contextual bridge shortcut.
- Query params can preselect a token where practical.
- All verification gates pass.
- Plan status is updated in this file and `plans/README.md`.

## STOP Conditions

Stop and ask before shipping if:

- WanBridge no longer returns VinuChain token pairs.
- The VinuSwap bridge implementation has been removed or replaced with a
  materially different provider.
- Gatsby Functions cannot support the API proxy shape needed for WanBridge
  transaction creation.
- The wallet provider cannot expose chain switching or transaction signing
  without replacing the wallet stack.
- WanBridge requires a registered partner value and `"VinuNFT"` is not accepted.
- The bridge shortcut would imply a token is accepted for payment when the
  marketplace does not actually support it.
- The implementation would require contract or custody changes.

## Maintenance Notes

- Keep VinuNFT's bridge model close to VinuSwap's WanBridge implementation. If
  VinuSwap updates its WanBridge files, compare and port relevant safety fixes.
- Review VinuChain RPC/explorer values against `src/config.js`; do not copy stale
  VinuSwap RPC or explorer URLs over VinuNFT's current config.
- Keep WanBridge API calls server-side where transaction creation or validation
  is involved.
- Revisit bridge shortcut placement after marketplace discovery work lands,
  because card-level buy buttons may expose better token-context insertion
  points.
