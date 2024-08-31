import React, { useEffect } from "react";
import { useRecoilState } from "recoil";
import { standardErrorState } from "../common/error";

export default function StandardErrorDisplay() {
    const [standardError, setStandardError] =
        useRecoilState(standardErrorState);

    return standardError ? (
        <article className="message is-danger">
            <div className="message-header">
                <p>Error</p>
                <div
                    className="delete"
                    aria-label="delete"
                    role="button"
                    onClick={() => setStandardError(null)}
                ></div>
            </div>
            <div className="message-body">{standardError}</div>
        </article>
    ) : (
        <></>
    );
}
