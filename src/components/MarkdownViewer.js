import React from "react";
import { useState, useRef } from "react";
import { sanitizeMarkdown } from "../common/sanitize";

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

    return (
        <iframe
            ref={ref}
            onLoad={onLoad}
            height={height}
            style={{ width: "100%", overflow: "auto" }}
            srcDoc={sanitizeMarkdown(source)}
            // WHY a value and not a bare `sandbox`: React drops `sandbox={true}`
            // for a string attribute, so the built page shipped an iframe with no
            // sandbox at all — the second layer this repo documents did not exist.
            // `allow-same-origin` and nothing else: scripts, forms, popups,
            // downloads and top-level navigation stay off, while the frame keeps
            // the parent origin so onLoad can measure its height. Adding
            // allow-scripts would hand attacker-authored markup a same-origin
            // script context; it must never be added.
            sandbox="allow-same-origin"
        />
    );
}
