import React from "react";
import { useState, useRef } from "react";
import { sanitizeHtml } from "../common/sanitize";

export default function HTMLViewer({ source }) {
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
            srcDoc={sanitizeHtml(source)}
            sandbox
        />
    );
}
