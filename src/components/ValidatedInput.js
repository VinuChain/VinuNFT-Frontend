import React from "react";

export default function ValidatedInput(props) {
    // The label used to sit beside the input with nothing tying the two
    // together, so all twelve fields in the Create form and the transactional
    // modals were announced as unnamed. One generated id fixes every caller.
    const id = React.useId();
    const relevantProps = { ...props };
    delete relevantProps.label;
    delete relevantProps.name;
    delete relevantProps.errors;
    delete relevantProps.register;

    const error = props.errors[props.name];

    return (
        <div className="field">
            <label className="label" htmlFor={id}>
                {props.label}
            </label>
            <div className="control">
                <input
                    id={id}
                    className={"input" + (error ? " is-danger" : "")}
                    {...relevantProps}
                    {...props.register(props.name)}
                />
            </div>
            {error ? <p className="help is-danger">{error.message}</p> : <></>}
        </div>
    );
}
