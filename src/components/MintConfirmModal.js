import React from "react";
import ModalCard from "./ModalCard";

export default function MintConfirmModal({ isOpen, setIsOpen, onClose }) {
    const closeModal = (confirmed) => {
        setIsOpen(false);
        onClose(confirmed);
    };

    if (!isOpen) return <></>;

    return (
        <ModalCard
            title="Some fields are empty. Mint anyway?"
            onDismiss={() => closeModal(false)}
        >
            <footer className="modal-card-foot">
                <button
                    className="button is-black"
                    onClick={() => closeModal(true)}
                >
                    Yes
                </button>
                <button
                    className="button is-black"
                    onClick={() => closeModal(false)}
                >
                    No
                </button>
            </footer>
        </ModalCard>
    );
}
