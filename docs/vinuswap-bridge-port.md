# VinuSwap Bridge Port

## Source Files

The port follows these VinuSwap files:

- `/home/gypsey/VinuSwap-Frontend/src/common/wanbridge.ts`
- `/home/gypsey/VinuSwap-Frontend/src/common/wanbridgeValidation.ts`
- `/home/gypsey/VinuSwap-Frontend/src/pages/api/wanbridge/token-pairs.ts`
- `/home/gypsey/VinuSwap-Frontend/src/pages/api/wanbridge/quota-and-fee.ts`
- `/home/gypsey/VinuSwap-Frontend/src/pages/api/wanbridge/create-tx.ts`
- `/home/gypsey/VinuSwap-Frontend/src/pages/bridge.tsx`

## VinuNFT Replacement Files

- `src/common/wanbridge.js`
- `src/common/wanbridgeValidation.js`
- `src/common/apiRateLimit.js`
- `src/api/wanbridge-token-pairs.js`
- `src/api/wanbridge-quota-and-fee.js`
- `src/api/wanbridge-create-tx.js`
- `src/pages/bridge.js`
- `src/components/BridgeShortcut.js`

## Port Differences

VinuSwap is Next/TypeScript with ethers v6 and styled-components. VinuNFT is
Gatsby/React JavaScript with ethers v5, Web3Modal v1, Gatsby Functions under
`src/api`, and Bulma/global CSS. The port keeps WanBridge route discovery,
quota/fee checks, transaction creation, chain switching, allowance handling, and
exact transaction submission, but uses VinuNFT's provider and style system.

## API Shape

The Gatsby Function paths are:

- `/api/wanbridge-token-pairs`
- `/api/wanbridge-quota-and-fee`
- `/api/wanbridge-create-tx`

The flatter filenames avoid Gatsby routing ambiguity while keeping WanBridge
transaction creation server-side.

## Partner Value

`WANBRIDGE_PARTNER = "VinuNFT"`. If WanBridge requires an already registered
partner string, stop before shipping and confirm whether upstream accounting
must use `"VinuSwap"`.
