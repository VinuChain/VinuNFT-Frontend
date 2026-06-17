import React from "react";
import { useState, useRef } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify/lib";
import { schemas } from "../common";

export default function MarkdownViewer({ source }) {
    const [height, setHeight] = useState("0px");
    const ref = useRef();

    const PADDING = 1.25; // rem

    const convertRemToPixels = (rem) => {
        return (
            rem *
            parseFloat(getComputedStyle(document.documentElement).fontSize)
        );
    };

    const onLoad = () => {
        if (typeof window !== "undefined") {
            setHeight(
                parseFloat(
                    ref.current.contentWindow.document.body.scrollHeight
                ) +
                    convertRemToPixels(PADDING * 2) +
                    "px"
            );
        }
    };

    const sanitize = (markdown) => {
        const sanitized = unified()
            .use(remarkParse)
            .use(remarkRehype)
            .use(rehypeSanitize, schemas.validMarkdown)
            .use(rehypeStringify)
            .processSync(markdown);
        return sanitized.value;
    };

    return (
        <iframe
            ref={ref}
            onLoad={onLoad}
            height={height}
            style={{ width: "100%", overflow: "auto" }}
            srcDoc={sanitize(source)}
            sandbox
        />
    );
}
