import React from "react";
import useModalFocus from "../common/useModalFocus";

const styles = {
    modalCard: {
        maxWidth: "80vw",
    },
    modalCardTitle: {
        overflowWrap: "break-word",
        maxWidth: "70vw",
    },
};

/**
 * The one modal shell.
 *
 * Seven modals carried a byte-identical copy of this markup and none of them
 * was a dialog: no role, no accessible name, no focus management, and a
 * backdrop click as the only way out — so a keyboard user who opened one was
 * stuck in it. Consolidating is what makes fixing that a single edit.
 *
 * Mounted only while open (each caller still returns early when it is closed),
 * because the focus hook records the opener and restores it on unmount.
 */
export default function ModalCard({ title, onDismiss, children }) {
    const titleId = React.useId();
    const cardRef = useModalFocus(onDismiss);

    return (
        <div className="modal is-active">
            <div className="modal-background" onClick={onDismiss} />
            <div
                className="modal-card"
                style={styles.modalCard}
                ref={cardRef}
                // Focus has to land somewhere even in a dialog whose only
                // controls are disabled, and it must not land outside.
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
            >
                <header className="modal-card-head">
                    <p
                        className="modal-card-title"
                        id={titleId}
                        style={styles.modalCardTitle}
                    >
                        {title}
                    </p>
                    {/* is-medium is 24px: Bulma's default .delete is 20px and
                        fails the 24x24 pointer-target floor on a phone. */}
                    <button
                        type="button"
                        className="delete is-medium"
                        aria-label="Close"
                        onClick={onDismiss}
                    />
                </header>
                {children}
            </div>
        </div>
    );
}
