import { useEffect, useRef } from "react";

// Everything a browser puts in the tab order that a modal can contain. Order
// matters: querySelectorAll returns document order, which is what Tab follows.
const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Make a modal behave like a dialog for someone without a mouse.
 *
 * Every modal in this app authorises a signature, and dismissal was
 * pointer-only: clicking the backdrop. A keyboard user could open one and never
 * leave it, and focus stayed on the page behind, so a screen reader kept
 * reading content the modal had covered.
 *
 * Returns the ref to put on the `.modal-card`. The card itself must carry
 * `tabIndex={-1}` so a dialog with no focusable child still receives focus
 * rather than leaving it outside.
 */
export default function useModalFocus(onDismiss) {
    const cardRef = useRef(null);
    // Held in a ref so the effect can stay mount-scoped: re-running it on every
    // render of a parent would re-record the opener as the modal's own content.
    const dismissRef = useRef(onDismiss);
    dismissRef.current = onDismiss;

    useEffect(() => {
        const card = cardRef.current;
        if (!card) return undefined;

        const opener = document.activeElement;
        const focusable = () => [...card.querySelectorAll(FOCUSABLE)];
        (focusable()[0] ?? card).focus();

        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                dismissRef.current?.();
                return;
            }
            if (event.key !== "Tab") return;

            const nodes = focusable();
            if (nodes.length === 0) {
                event.preventDefault();
                card.focus();
                return;
            }
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            // Wrapping only at the ends leaves the browser's own tab order
            // intact in between, so nothing here has to model focus semantics.
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            } else if (!card.contains(document.activeElement)) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            // The modals unmount on close, so restoring here covers every exit
            // — Escape, the close button, the backdrop and the action buttons.
            if (opener && document.contains(opener)) {
                opener.focus();
            }
        };
    }, []);

    return cardRef;
}
