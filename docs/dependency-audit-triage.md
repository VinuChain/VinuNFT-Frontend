# Dependency Audit Triage

`yarn audit:triage` runs `yarn audit --json --groups dependencies` and fails when
any severity exceeds the baseline in `scripts/audit-triage.js`. This document is
what the number means.

## Position

| Severity | Baseline (2026-09-01) | Previous (2026-08-20) |
|---|---:|---:|
| Critical | 2 | 39 |
| High | 28 | 252 |
| Moderate | 28 | 153 |
| Low | 13 | 109 |
| **Total advisories** | **71** | **553** |
| Audited packages | 1652 | 2365 |

The baseline is the exact observed count, so a newly published advisory against a
package that is still installed fails the gate. That is intended. The response is
to re-read this document and decide whether the new advisory is reachable — not
to raise the number.

## How the 482 advisories went away

Three different things, deliberately not summed into one figure.

### 1. Uninstalled — 91 advisories, 713 fewer packages

These roots had zero imports across `src/`, `gatsby-*.js`, `add_csp.js`,
`scripts/` and `test/`, and are gone from `package.json`:

| Root removed | Advisories it carried | Why it was dead |
|---|---:|---|
| `crypto-browserify` | 26 | `resolve.fallback` shim; a fallback only activates when a module requests the builtin, and none did |
| `net-browserify` | 18 | same |
| `tls-browserify` | 15 | same |
| `browserify-fs` | 4 | same |
| `sanitize-html` | 11 | sanitisation goes through `unified` + `rehype-sanitize` in `src/common/sanitize.js` |
| `gatsby-source-filesystem` | 8 | sourced `./src/pages` into GraphQL; no page runs a `graphql` query or `useStaticQuery` |
| `file-loader` | 6 | never referenced by a webpack rule |
| `ws` | 3 | one commented-out import |

Also removed with no advisories of their own: `assert`, `https-browserify`,
`stream-http`, `stream-browserify`, `os-browserify`, `path-browserify`,
`zlib-browserify`, `url-polyfill` (the rest of the inert fallback block),
`browserslist`, `recoil-persist`, `rehype-react`, `gatsby-plugin-csp` (the
plugins array uses `gatsby-plugin-csp-nonce`, a different package).

`buffer` and `process` were kept: both are supplied by `ProvidePlugin` and
`Buffer` is referenced in the emitted bundle.

**Compatibility evidence.** A webpack `resolve.fallback` entry only activates
when something requests the builtin, so `yarn clean && yarn build` either
succeeds — proving nothing needed them — or fails naming the requester. It
succeeds. That result is also the reachability proof used below: with no
fallbacks at all, nothing in the browser graph can `require("net")`,
`require("tls")`, `require("crypto")` or `require("http")`.

### 2. Reclassified, still installed — 2 advisories

`husky` (0 advisories) and `lint-staged` (2) moved from `dependencies` to
`devDependencies`. They are commit-hook tooling; they were never production
dependencies. They are still on disk, so this is a scoping change, not a
remediation, and it is 2 of the 482.

### 3. Upgraded within the declared range — the rest

No `package.json` range changed; this is a lockfile re-resolution.

| Package | Was | Now | Advisories |
|---|---|---|---:|
| `gatsby` | 5.13.7 | 5.16.1 | 324 -> 46 |
| `ethers` | 5.5.2 | 5.8.0 | 67 -> 11 |
| `@uiw/react-md-editor` | 3.9.3 | 3.25.6 | 58 -> 0 |
| `joi` | 17.5.0 | 17.13.6 | 2 -> 0 |
| `query-string` | 7.0.1 | 7.1.3 | 2 -> 1 |
| `react-hook-form` | 7.15.3 | 7.87.0 | 0 |
| `react-tooltip` | 4.2.21 | 4.5.1 | 1 |

`joi` matters most here: it validates hostile token metadata in
`src/common/nftInfo.js`, and 17.5.0 carried an uncaught `RangeError` on deeply
nested input through recursive `link()` schemas. `query-string` pulled
`decode-uri-component` from 0.2.0 to 0.2.2, closing the high-severity DoS on
`location.search` parsing.

**Compatibility evidence for the upgrade:** `yarn lint`, `yarn clean && yarn
build`, `yarn test` (578), `yarn verify:rendered` (145 in Chromium against the
built `public/`), `yarn verify:csp` (13) and `yarn verify:deployed` (every
frontend ABI function `eth_call`ed against deployed bytecode) all pass. The
rendered and deployed gates are the ones that would catch an `ethers` behaviour
change; the 145 browser tests drive buy, list, transfer, burn, mint and bridge
against the real build.

## The 71 that remain, and why each class is not exploitable here

### `gatsby` — 46, build toolchain only

`sharp`, `webpack`, `js-yaml`, `immutable`, `lodash`, `ajv`, `cross-spawn`,
`tmp`, `flatted`, `semver`, `serialize-javascript`, `path-to-regexp`, `cookie`,
`word-wrap`, `file-type`, `uuid`, `@parcel/reporter-dev-server`. The deployed
artifact is the static `public/` directory — no Gatsby process runs in
production, and `@parcel/reporter-dev-server` and `path-to-regexp`/`cookie` only
exist inside `gatsby develop`. Reaching any of these requires already being able
to run the build.

### `ethers` — 11

- `elliptic` low x9: **reachable, and confirmed in the shipped bundle.** The
  package name does not survive minification, so grepping for `elliptic` finds
  nothing; grepping for what it emits does. `public/app-*.js` contains
  elliptic's own curve preset — `("secp256k1",{type:"short",prime:"k256",...})`
  — next to `signing-key/5.8.0` constructing `new EC("secp256k1")`. There is no
  fixed version (`patched_versions: <0.0.0`); the advisory is the risky
  primitive itself. The only remediation is ethers 6, which signs with
  `@noble/curves` instead. This is the strongest concrete argument for that
  migration.
- `ws` high x1 + moderate x1: `WebSocketProvider` only. The app has no
  `WebSocketProvider` (`grep` in `src/` is empty) and reads through
  `JsonRpcProvider`/`AlchemyProvider` over HTTPS. `ws` needs `net`/`tls`, and the
  build resolves neither, so it is not in the bundle.

### `eth-provider` — 5

`ws` high x2 + moderate x1, `cookiejar` moderate x1 (via `xhr2-cookies`), `uuid`
moderate x1. All are the Node transport half of the package; the browser build
uses the injected wallet provider. Same fallback proof: `ws` and `xhr2-cookies`
cannot be in a graph that resolves no `net`, `tls` or `http`.

### `styled-components` build plugin — 5, incl. both criticals

`react-drag-drop-files` (4) and `web3modal` (1) both pull
`styled-components` -> `@babel/traverse` critical and
`babel-plugin-styled-components` -> `lodash`. `@babel/traverse`'s arbitrary code
execution requires an attacker to control source code being *compiled*; the
plugin runs at build time over this repository's own source. No NFT content, no
route parameter and no API response ever reaches a Babel compile.

### `uuid` moderate x2 (`react-tooltip`, `eth-provider`)

Missing buffer bounds check in v3/v5/v6 **when `buf` is provided**. Nothing in
`src/` calls `uuid`; both callers use v4 with no `buf`. The fix is uuid 11, well
outside both packages' declared ranges.

### `@babel/runtime` moderate x2 (`@geoffcox/react-splitter`, `gatsby-plugin-react-helmet`)

ReDoS in transpiled `.replace` with named capturing groups. It fires only when
attacker-controlled input reaches such a call; the splitter transpiles drag
geometry and the helmet plugin transpiles tag props built from validated route
parameters (`src/common/socialPreview.js`).

### `query-string` -> `decode-uri-component` moderate x1

**Reachable input** — `location.search` is whatever a crafted link contains. The
remaining advisory needs 0.5.0, outside query-string 7's `^0.2.0` range. The
impact is exponential decoding of malformed percent-encoding: the visitor's own
tab stalls on a link they clicked. There is no server to exhaust. Upgrade path is
query-string 8/9 (ESM-only) or dropping it for the platform's `URLSearchParams`,
which touches `src/pages/nft/index.js`.

## Deferred, with the reason

These are the criterion's remaining unmet part, and the residual 71 above is what
measures it.

- **ethers 5 -> 6.** Rewrites `ethers.utils.*`, `ethers.providers.*` and
  `BigNumber` across essentially every file in `src/`. It is the only fix for the
  9 `elliptic` advisories. It also moves the Alchemy mainnet host from
  `eth-mainnet.alchemyapi.io` to `eth-mainnet.g.alchemy.com`, so
  `CONNECT_SRC_ORIGINS` in `add_csp.js` has to change in the same commit or every
  ENS lookup is refused by CSP.
- **`@uiw/react-md-editor` 3 -> 4.** Now carries 0 advisories at 3.25.6, so this
  is currency, not remediation.
- **`web3modal` -> `@reown/appkit`.** `web3modal` 1.x is deprecated upstream. Its
  single advisory is the build-time `@babel/traverse` above.
- **`prismjs`.** Pinned by `refractor` at `~1.25.0`. It carries no advisory in
  the current audit, and it is editor-only regardless: third-party NFT bodies
  render through `HTMLViewer`/`MarkdownViewer`
  (`src/pages/nft/index.js`), so the highlighter only ever sees the creator's own
  input in `MultiEditor.js`. No `resolutions` override was added.

## Other mitigations in this repo

- Pinata writes moved out of the browser bundle to `src/api/upload-ipfs.js`; the
  client no longer reads a public `GATSBY_*JWT*` value.
- The upload function requires a payload-digest-bound wallet signature from an
  allowlisted wallet and applies per-wallet/IP/global rate limits before using
  the server-held JWT.
- The PHP social-preview route that fetched user-controlled NFT metadata was
  removed.
- HTML sanitisation does not expand the default schema with `style` tags,
  `style` attributes or `data:` URLs.
- `img-src` names the configured IPFS gateway origins instead of every `https:`
  host, and `form-action 'none'` is set.
