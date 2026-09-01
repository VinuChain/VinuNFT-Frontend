import Joi from "joi";
import { defaultSchema as rehypeDefaultSchema } from "rehype-sanitize";

const ensDomain = Joi.string().domain({ tlds: { allow: ["eth"] } });
const ethAddress = Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/);

const ADDRESS_MESSAGE = '"Address" must be a valid Ethereum name or address';

const validateRecipient = (value, helpers) => {
    if (!value) {
        return helpers.error("any.required");
    }
    const wellFormed = value.includes(".eth") ? ensDomain : ethAddress;
    if (wellFormed.validate(value).error) {
        return helpers.error("custom.address");
    }
    return value;
};

const recipient = Joi.string()
    .custom(validateRecipient)
    .messages({ "custom.address": ADDRESS_MESSAGE });

// Only the mint form has a useCustomRecipient toggle; every other form must
// apply `recipient` directly, or the "otherwise" branch accepts any string.
const _customRecipient = Joi.when("useCustomRecipient", {
    is: true,
    then: recipient,
    otherwise: Joi.string().empty(""),
});

const maxDigits = (max) => (value, helpers) => {
    const convertedValue = helpers.original + "";
    if (convertedValue.includes(".")) {
        const digitCount = convertedValue.split(".")[1].length;
        if (digitCount > max) {
            return helpers.error("number.precision", { limit: max });
        }
    }

    return value;
};

const etherValidator = (label) => (value, helpers) => {
    const joiSchema = Joi.number().positive().unsafe(true).label(label);

    try {
        Joi.assert(value, joiSchema);
    } catch (e) {
        return helpers.message(e.details[0].message);
    }

    // Check the precision
    if (value.includes(".")) {
        const digitCount = value.split(".")[1].length;
        if (digitCount > 18) {
            return helpers.message(
                `"${label}" must have at most 18 decimal places after the decimal point`
            );
        }
    }

    if (value.endsWith(".")) {
        return value.slice(0, -1);
    }

    return value;
};

const mint = Joi.object().keys({
    title: Joi.string().allow("").label("Title"),
    description: Joi.string().allow("").label("Description"),
    editionSize: Joi.number()
        .integer()
        .min(1)
        .empty("")
        .required()
        .label("Edition size"),
    royaltyPercentage: Joi.number()
        .custom(maxDigits(2))
        .min(0)
        .max(100)
        .empty("")
        .required()
        .label("Royalty percentage"),
    useCustomRecipient: Joi.boolean().required(),
    customRecipient: _customRecipient.label("Address"),
    dataType: Joi.valid(
        "text/plain",
        "text/markdown",
        "text/html",
        "image"
    ).required(),
});

const transfer = Joi.object().keys({
    to: recipient
        .required()
        // A blank recipient is the same user mistake as a malformed one, so it
        // gets the same actionable sentence rather than joi's default.
        .messages({
            "string.empty": ADDRESS_MESSAGE,
            "any.required": ADDRESS_MESSAGE,
        })
        .label("Address"),
    amount: Joi.number().integer().min(1).empty("").required().label("Amount"),
});

const buy = Joi.object().keys({
    amount: Joi.number().integer().min(1).empty("").required().label("Amount"),
});

const edit = Joi.object().keys({
    amount: Joi.number().min(1).empty("").label("Amount"),
    price: Joi.string()
        .custom(etherValidator("Price"))
        .empty("")
        .label("Price"),
});

const list = Joi.object().keys({
    amount: Joi.number().min(1).empty("").required().label("Amount"),
    price: Joi.string()
        .custom(etherValidator("Price"))
        .empty("")
        .required()
        .label("Price"),
    paymentToken: Joi.string().empty("").required().label("Payment Token"),
});

const burn = Joi.object().keys({
    amount: Joi.number().integer().min(1).empty("").required().label("Amount"),
});

const editRoyalty = Joi.object().keys({
    royaltyPercentage: Joi.number()
        .custom(maxDigits(2))
        .min(0)
        .max(100)
        .empty("")
        .required()
        .label("Royalty percentage"),
});

const validMarkdown = { ...rehypeDefaultSchema };

const validHTML = {
    ...rehypeDefaultSchema,
    attributes: {
        ...rehypeDefaultSchema.attributes,
        "*": [...rehypeDefaultSchema.attributes["*"], "class", "className"],
    },
};

export default {
    burn,
    buy,
    edit,
    editRoyalty,
    list,
    validHTML,
    validMarkdown,
    mint,
    transfer,
};
