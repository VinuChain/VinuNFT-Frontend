import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeParse from "rehype-parse";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import schemas from "./schemas";

/**
 * The one sanitisation contract for user-authored NFT content.
 *
 * Both viewers previously built their own unified pipeline. Two pipelines for
 * the same guarantee is one too many: the editor preview and the final render
 * must agree exactly, or a creator approves something different from what
 * buyers see. These are the only two entry points, and they are what the
 * adversarial fixtures in `test/sanitize.test.mjs` exercise.
 *
 * Sanitisation is the first of two layers. Both viewers additionally render the
 * result into `<iframe sandbox="allow-same-origin">`, so even a bypass here
 * lands in a context with scripts, forms, popups and top-level navigation
 * disabled. Same-origin is the one flag granted, because the viewers measure
 * their own height through the frame's DOM; it is harmless only for as long as
 * `allow-scripts` stays absent. (Until this was fixed the attribute was written
 * as a bare `sandbox`, which React drops, so no sandbox shipped at all.)
 */
/**
 * The rehype plugin list for the Markdown editor's live preview.
 *
 * `@uiw/react-md-editor` renders its own preview, so it cannot call
 * `sanitizeMarkdown` directly. Exporting the plugin list keeps the preview and
 * the published render on one schema by construction rather than by two places
 * happening to name the same one.
 */
export function markdownRehypePlugins() {
    return [() => rehypeSanitize(schemas.validMarkdown)];
}

export function sanitizeMarkdown(source) {
    return String(
        unified()
            .use(remarkParse)
            .use(remarkRehype)
            .use(rehypeSanitize, schemas.validMarkdown)
            .use(rehypeStringify)
            .processSync(source ?? "")
    );
}

export function sanitizeHtml(source) {
    return String(
        unified()
            .use(rehypeParse, { fragment: true })
            .use(rehypeSanitize, schemas.validHTML)
            .use(rehypeStringify)
            .processSync(source ?? "")
    );
}
