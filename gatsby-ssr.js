import { wrapPageElement } from "./src/common/preprocess";

/**
 * Declare the document language.
 *
 * Without it a screen reader falls back to the user's system language and can
 * read English content with the wrong pronunciation rules, and automatic
 * translation has nothing to key off. Gatsby does not set this by default.
 */
export function onRenderBody({ setHtmlAttributes }) {
    setHtmlAttributes({ lang: "en" });
}

export { wrapPageElement };
