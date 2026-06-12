# Safe Social Preview Design

## Supported Inputs

Safe previews accept only `type` and numeric `id`. `type` must be `text` or
`image`; `id` must be a positive integer.

## Data Sources

Allowed data sources are bounded contract reads and the configured allowlisted
IPFS gateway. Disallowed data sources include arbitrary metadata URLs,
user-supplied gateway URLs, and server-side fetches of untrusted metadata.

## Safety Requirements

- Every network fetch needs an explicit timeout.
- Every HTML attribute and text value must be escaped before it is returned.
- Metadata failures fall back to a generic VinuNFT preview.
- The removed PHP route must stay removed.

## First slice

The first slice is static safe metadata only. NFT pages add route-query-based
Helmet tags such as `og:title`, `og:type`, and `twitter:card`; they do not fetch
user metadata server-side. Serverless or indexer-generated previews can be added
later only after validated token IDs, allowlisted gateways, escaping, and
timeouts are implemented.

## Fallback

When the page cannot derive a valid token ID from the URL, it uses the generic
`VinuNFT` title and description. The fallback preview is safe because it contains
no user-controlled token metadata.
