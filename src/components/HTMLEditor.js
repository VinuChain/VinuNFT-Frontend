import React from "react";

import HTMLViewer from "./HTMLViewer";

export default function HTMLEditor({ value, setValue }) {
    if (typeof window !== "undefined") {
        const AceEditor = require("react-ace").default;
        require("ace-builds/src-noconflict/mode-html");
        require("ace-builds/src-noconflict/theme-github");
        require("ace-builds/src-noconflict/theme-monokai");
        const { Split } = require("@geoffcox/react-splitter");

        return (
            <>
                <div className="Resizer" style={{ height: "500px" }}>
                    <Split
                        vertical
                        onSplitChanged={() =>
                            window.dispatchEvent(new Event("resize"))
                        }
                    >
                        <div>
                            <AceEditor
                                mode="html"
                                theme="monokai"
                                onChange={setValue}
                                name="html-editor"
                                editorProps={{ $blockScrolling: false }}
                                setOptions={{
                                    enableBasicAutocompletion: true,
                                    enableLiveAutocompletion: true,
                                    enableSnippets: true,
                                }}
                                width="100%"
                            />
                        </div>
                        <div style={{ height: "100%", overflow: "scroll" }}>
                            <HTMLViewer source={value} />
                        </div>
                    </Split>
                </div>
                <article className="message is-info is-small mt-2">
                    <div className="message-body">
                        <p>
                            <strong>Note</strong>: content is sanitised with the
                            GitHub-flavoured allowlist. Ordinary formatting,
                            headings, lists, tables, images, links and{" "}
                            <tt>class</tt> attributes are kept. Anything that
                            could run code is removed: <tt>{"<script>"}</tt>,{" "}
                            <tt>{"<iframe>"}</tt>, <tt>{"<style>"}</tt>,{" "}
                            <tt>{"<form>"}</tt>, event handlers such as{" "}
                            <tt>onclick</tt>, and <tt>javascript:</tt> or{" "}
                            <tt>data:</tt> URLs. The preview above applies
                            exactly the same rules as the published NFT, so what
                            you see here is what buyers see.
                        </p>
                    </div>
                </article>
            </>
        );
    }
    return null;
}
