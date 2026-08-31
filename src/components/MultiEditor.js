import React from "react";
import MDEditor from "@uiw/react-md-editor";
import { defaultCommands } from "../common/commands";
import { markdownRehypePlugins } from "../common/sanitize";

import HTMLEditor from "./HTMLEditor";

const styles = {
    link: {
        textDecoration: "underline",
    },
    plainEditor: {
        fontFamily: "monospace",
    },
};

export default function MultiEditor({ dataType, value, setValue }) {
    switch (dataType) {
        case "text/markdown":
            return (
                <div>
                    <MDEditor
                        value={value}
                        onChange={setValue}
                        highlightEnable={false}
                        // Same plugin list the published render uses, so
                        // the preview cannot become more permissive than what
                        // buyers eventually see.
                        previewOptions={{
                            rehypePlugins: markdownRehypePlugins(),
                        }}
                        commands={defaultCommands}
                    />
                    <article className="message is-info is-small mt-2">
                        <div className="message-body">
                            <p>
                                For help regarding Markdown, see the{" "}
                                <a
                                    style={styles.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    href="https://docs.github.com/en/github/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax"
                                >
                                    GitHub Flavored Markdown guide
                                </a>{" "}
                                and the{" "}
                                <a
                                    style={styles.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    href="https://github.github.com/gfm/"
                                >
                                    official spec
                                </a>
                                .
                            </p>
                        </div>
                    </article>
                </div>
            );
        case "text/plain":
            return (
                <textarea
                    style={styles.plainEditor}
                    className="textarea"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder="Content of your artwork"
                ></textarea>
            );
        case "text/html":
            return <HTMLEditor value={value} setValue={setValue} />;
        default:
            return <p>Unsupported editor</p>;
    }
}
