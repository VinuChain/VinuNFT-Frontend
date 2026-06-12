# Plan 004: Restore Rich Text Minting Safely

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not enable HTML minting without confirming sanitizer and preview
> behavior. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a00888a..HEAD -- src/pages/mint.js src/components/MultiEditor.js src/components/HTMLEditor.js src/components/HTMLViewer.js src/common/schemas.js src/common/minting.js src/components/TypeTag.js test/audit-regressions.test.js README.md docs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `a00888a`, 2026-06-12

## Why This Matters

VinuNFT has rich text infrastructure: markdown editor, HTML editor, sanitizers,
HTML viewer, and type tags. The mint UI currently hides markdown and HTML,
leaving only image and plain text. Restoring rich text as a controlled feature
would differentiate VinuNFT while preserving the security lessons already
encoded in sanitizer tests.

## Current State

- `src/pages/mint.js` - form schema allows markdown and HTML, but the select
  comments out those options.
- `src/components/MultiEditor.js` - already renders markdown, plain text, and
  HTML editor modes.
- `src/components/HTMLEditor.js` - Ace editor plus live HTML preview.
- `src/common/schemas.js` - `mint` allows `text/markdown` and `text/html`;
  sanitizer schemas exist.
- `test/audit-regressions.test.js` - asserts HTML sanitizer does not allow
  style or data URL expansion.

Key excerpts:

```js
// src/pages/mint.js:151-160
<select {...register("dataType")} id="content">
    <option value="image">Image</option>
    <option value="text/plain">
        Plain Text
    </option>
    {/*<option value="text/markdown">
        Markdown
    </option>
    <option value="text/html">HTML</option>*/}
</select>
```

```js
// src/components/MultiEditor.js:20-34
switch (dataType) {
    case "text/markdown":
        return (
            <MDEditor
                value={value}
                onChange={setValue}
                highlightEnable={false}
                previewOptions={{
                    rehypePlugins: [
                        () => rehypeSanitize(schemas.validMarkdown),
                    ],
                }}
                commands={defaultCommands}
            />
```

```js
// src/components/HTMLEditor.js:45-48
<strong>Note</strong>: Most HTML tags are supported,
with the notable exception of <tt>{"<script>"}</tt>.
A full list of the allowed tags will be released
soon.
```

```js
// src/common/schemas.js:89-94
dataType: Joi.valid(
    "text/plain",
    "text/markdown",
    "text/html",
    "image"
).required(),
```

Repo conventions to match:

- Use existing `react-hook-form` plus Joi validation in `src/pages/mint.js`.
- Use existing `MultiEditor` rather than adding a second editor stack.
- Security-sensitive sanitizer behavior belongs in `src/common/schemas.js` and
  `test/audit-regressions.test.js`.
- UI copy should be concise and embedded in the form, not a marketing page.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---|---|---|
| Use compatible Node | `node --version` | version is `>=18 <23`; README recommends Node 20 |
| Install if needed | `yarn install --frozen-lockfile` | exit 0 |
| Lint | `yarn lint` | exit 0 |
| Tests | `yarn test` | all tests pass |
| Dependency audit ratchet | `yarn audit:triage` | exits 0 unless dependency risk worsened |
| Production build | `yarn build` | exits 0; Gatsby may print existing plugin/dependency warnings |

If the shell default Node is outside `>=18 <23`, use a compatible local Node
before running Yarn, for example `source ~/.nvm/nvm.sh && nvm use 22.22.0`.

## Scope

**In scope**:

- Design note, for example `docs/rich-text-minting.md`.
- `src/pages/mint.js` content selector and any helper copy.
- `src/components/MultiEditor.js`, `src/components/HTMLEditor.js`,
  `src/components/HTMLViewer.js` only as needed for safe editor behavior.
- `src/common/schemas.js` sanitizer/schema changes.
- `test/audit-regressions.test.js`.
- README updates if user-facing supported content types change.

**Out of scope**:

- New editor dependencies unless there is a documented blocker with the existing
  editors.
- Weakening sanitizer rules to allow scripts, inline styles, unsafe URLs, or
  arbitrary data URLs in HTML.
- Changing minted token URI format beyond existing text data URI behavior.
- Reworking image minting.

## Git Workflow

- Suggested branch: `advisor/004-rich-text-minting`.
- Commit style in this repo is short sentence case, for example
  `Fixed image scaling on desktop.`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the rich-text safety note

Create `docs/rich-text-minting.md`. It must state:

- Which rich types are enabled first: markdown only, or markdown plus HTML.
- Which sanitizer schema applies to preview and detail rendering.
- Which tags/attributes/protocols are intentionally disallowed.
- How the UI warns users about sanitized output.
- Rollback plan if unsafe rendering is found.

**Verify**:
`test -f docs/rich-text-minting.md && rg -n "markdown|HTML|sanitizer|disallowed|rollback|preview" docs/rich-text-minting.md`
-> prints matches for required topics.

### Step 2: Enable the selected content types in the mint UI

If the design note selects markdown only, uncomment/add the markdown option but
leave HTML disabled. If it selects HTML too, enable HTML only after verifying
the sanitizer section is explicit.

Use the existing `MultiEditor` component. Do not add another editor.

**Verify**:
`rg -n "text/markdown|text/html|MultiEditor|Content" src/pages/mint.js docs/rich-text-minting.md`
-> prints enabled options and the design note.

### Step 3: Align editor copy with the actual sanitizer

Update `HTMLEditor` copy if HTML is enabled. Replace vague copy like "Most HTML
tags are supported" with precise, supportable language, or link to the local
design note if docs are surfaced elsewhere. Keep it concise.

If HTML stays disabled, document that `HTMLEditor` remains dormant and do not
change it unless necessary.

**Verify**:
`rg -n "Most HTML tags|script|sanit|allowed tags|HTML stays disabled" src/components/HTMLEditor.js docs/rich-text-minting.md`
-> no stale vague promise remains if HTML is enabled.

### Step 4: Strengthen sanitizer regression tests

Extend `test/audit-regressions.test.js` to cover the selected rich text behavior:

- Markdown option exists if enabled.
- HTML option exists only if the design note enables it.
- HTML sanitizer still does not include `style` or `data` expansion.
- Markdown preview still uses `rehypeSanitize(schemas.validMarkdown)`.

**Verify**:
`yarn test` -> all tests pass, including rich-text checks.

### Step 5: Run full gates

Run the full repo verification gates.

**Verify**:

- `yarn lint` -> exit 0.
- `yarn test` -> all tests pass.
- `yarn audit:triage` -> exit 0 unless dependency baseline worsened.
- `yarn build` -> exit 0; existing Gatsby compatibility warnings may remain.

## Test Plan

- Extend `test/audit-regressions.test.js`.
- Prefer source-level checks for available options and sanitizer invariants.
- Do not add browser automation unless the operator requests visual verification
  for the editor.

## Done Criteria

All must hold:

- [ ] `docs/rich-text-minting.md` exists and chooses markdown-only or
      markdown-plus-HTML.
- [ ] Mint UI options match the design note.
- [ ] Existing sanitizer protections are preserved.
- [ ] New tests cover enabled rich text options and sanitizer invariants.
- [ ] `yarn lint`, `yarn test`, `yarn audit:triage`, and `yarn build` exit 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for Plan 004 is updated.

## STOP Conditions

Stop and report back if:

- Product wants HTML enabled but cannot accept sanitizer restrictions.
- Any required rendering path bypasses `rehypeSanitize` or `HTMLViewer`.
- Enabling HTML requires allowing scripts, styles, unsafe protocols, or data URLs
  in HTML.
- The editor dependencies fail to build under Gatsby 5.
- The code at the "Current state" excerpts has drifted materially.

## Maintenance Notes

- Rich text touches content safety and user trust. Reviewers should inspect
  sanitizer schemas and preview/detail rendering together.
- If future content types are added, update `TypeTag`, mint schema, editor UI,
  and regression tests in the same change.
- Avoid promising exact tag support in UI copy unless it is generated from or
  synchronized with the schema.
