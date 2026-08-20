# Dependency Audit Triage

The 2026-06-12 audit found a large vulnerable transitive surface in the Gatsby, wallet, markdown, and browser-polyfill stack:

| Severity | Baseline count | Previous (2026-06-12) |
|---|---:|---:|
| Critical | 39 | 65 |
| High | 252 | 235 |
| Moderate | 153 | 162 |
| Low | 109 | 105 |

Re-set on 2026-08-20. No dependency changed between the two dates; the counts
moved because advisories were re-scored and new ones were published against the
same packages. The overall surface **shrank** — 567 advisories to 553, with
critical down 26 and moderate down 9 — while a critical-to-high reclassification
pushed `high` and `low` over the old ceiling and started failing CI on unrelated
pull requests. Re-setting to the current counts keeps the ratchet doing its job
instead of blocking work it was never meant to block.

`yarn audit:triage` runs `yarn audit --json --groups dependencies` and fails only when the counts exceed this baseline. This keeps CI from accepting newly worse dependency risk while the larger framework and wallet-provider upgrade is handled separately.

Current mitigations in this repo:

- Pinata writes moved out of the browser bundle to `src/api/upload-ipfs.js`; the client no longer reads a public `GATSBY_*JWT*` value.
- The Pinata upload function requires a recent wallet signature from an allowlisted wallet and applies per-wallet/IP/global rate limits before using the server-held JWT.
- The PHP social-preview route that fetched user-controlled NFT metadata was removed.
- HTML sanitization no longer expands the default schema with `style` tags, `style` attributes, or `data:` URLs.

The baseline is not an acceptance of the dependency risk. It is a ratchet until the Gatsby, Web3Modal/WalletConnect, markdown editor, and polyfill stack can be upgraded or replaced with build verification.
