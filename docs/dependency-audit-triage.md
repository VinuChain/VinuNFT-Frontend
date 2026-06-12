# Dependency Audit Triage

The 2026-06-12 audit found a large vulnerable transitive surface in the Gatsby, wallet, markdown, and browser-polyfill stack:

| Severity | Baseline count |
|---|---:|
| Critical | 65 |
| High | 235 |
| Moderate | 162 |
| Low | 105 |

`yarn audit:triage` runs `yarn audit --json --groups dependencies` and fails only when the counts exceed this baseline. This keeps CI from accepting newly worse dependency risk while the larger framework and wallet-provider upgrade is handled separately.

Current mitigations in this repo:

- Pinata writes moved out of the browser bundle to `src/api/upload-ipfs.js`; the client no longer reads a public `GATSBY_*JWT*` value.
- The Pinata upload function requires a recent wallet signature from an allowlisted wallet and applies per-wallet/IP/global rate limits before using the server-held JWT.
- The PHP social-preview route that fetched user-controlled NFT metadata was removed.
- HTML sanitization no longer expands the default schema with `style` tags, `style` attributes, or `data:` URLs.

The baseline is not an acceptance of the dependency risk. It is a ratchet until the Gatsby, Web3Modal/WalletConnect, markdown editor, and polyfill stack can be upgraded or replaced with build verification.
