# Rich Text Minting

## Recommended MVP

Enable markdown first and keep HTML minting disabled. Markdown already uses the
existing `MultiEditor` preview and detail pages already render markdown through
`rehypeSanitize(schemas.validMarkdown)`.

## Sanitizer

Markdown preview and NFT detail rendering use `schemas.validMarkdown`. HTML
rendering remains dormant in the mint UI and must continue to use `HTMLViewer`
with the `validHTML` sanitizer if it is enabled later.

## Disallowed Content

Scripts, inline styles, unsafe URL protocols, and arbitrary data URLs stay
disallowed. The HTML sanitizer must not add `style` or broad `data` URL support.

## UI Warning

The mint form states that markdown is sanitized before preview and display.
Users should expect unsupported markup to be removed.

## Rollback

If unsafe rendering is found, remove the markdown option from the mint selector
and keep the schema/test guardrails in place until the sanitizer issue is fixed.

## HTML stays disabled

HTML minting stays disabled for this release because it has a broader tag and
attribute surface than markdown. Enabling it later requires a separate sanitizer
review and concise editor copy that matches the actual allowed schema.
