import React from "react";
import { useForm } from "react-hook-form";
import { joiResolver } from "@hookform/resolvers/joi";
import ValidatedInput from "./ValidatedInput";
import { schemas } from "../common";
import ModalCard from "./ModalCard";

const defaultValues = {
    amount: 1,
};

export default function BurnModal({
    isOpen,
    setIsOpen,
    onClose,
    balance,
    availableAmount,
}) {
    const {
        register,
        formState: { isDirty, isValid, errors },
        handleSubmit,
        watch,
    } = useForm({
        defaultValues,
        mode: "onChange",
        resolver: joiResolver(schemas.burn),
    });
    const watchAmount = watch("amount");

    const closeModal = (data) => {
        // console.log("Data: ", data);
        if (data) {
            onClose(data.amount);
        }
        setIsOpen(false);
    };

    if (!isOpen) return <></>;

    return (
        <ModalCard title="Burn NFT" onDismiss={() => closeModal(null, null)}>
            <section className="modal-card-body">
                <p>
                    Burning destroys these tokens permanently. They cannot be
                    recovered and the supply drops by the amount you burn.
                </p>
                <p>Balance: {balance}</p>
                {balance != availableAmount ? (
                    <p>Available (not listed) balance: {availableAmount}</p>
                ) : (
                    <></>
                )}
                <ValidatedInput
                    label="Amount"
                    name="amount"
                    type="number"
                    step="1"
                    min="1"
                    errors={errors}
                    register={register}
                />
                {watchAmount > availableAmount && watchAmount <= balance ? (
                    <p className="notification is-warning">
                        <b>Warning</b>: You only have {availableAmount} "free"
                        (not tied to listings) token
                        {availableAmount == 1 ? "" : "s"}. Proceeding will use{" "}
                        {watchAmount - availableAmount} token
                        {watchAmount - availableAmount == 1 ? "" : "s"} tied to
                        existing listings, making some listings unfulfillable.
                    </p>
                ) : (
                    <></>
                )}
                {watchAmount > balance ? (
                    <p className="notification is-danger">
                        <b>Error</b>: Cannot burn more tokens than you own (
                        {balance}).
                    </p>
                ) : (
                    <></>
                )}
            </section>
            <footer className="modal-card-foot">
                <button
                    className="button is-black"
                    disabled={(!isValid && isDirty) || watchAmount > balance}
                    onClick={handleSubmit(closeModal)}
                >
                    Burn
                </button>
            </footer>
        </ModalCard>
    );
}
