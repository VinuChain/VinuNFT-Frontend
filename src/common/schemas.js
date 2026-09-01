import Joi from "joi";
import config from "../config";
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

/**
 * A token's metadata document, as validated before anything renders it.
 *
 * `mint` stores whatever string it is handed, so every field here is written by
 * a stranger and read in a viewer's browser. A nested object or an array where
 * a string belongs throws inside React's render, and this app has no error
 * boundary — one hostile token would blank whichever page is showing it.
 *
 * Unknown keys are stripped rather than rejected: `external_link`,
 * `animation_url` and friends are not rendered by this app, and a field that
 * never enters state cannot later be picked up by a component that has
 * forgotten where it came from. `null` is accepted because real metadata writes
 * an absent field that way; that is a token saying it has no description, not a
 * malformed token, and the page reports the two differently.
 */
const tokenMetadata = Joi.object()
    .keys({
        name: Joi.string().max(512).allow(null, ""),
        description: Joi.string().max(8192).allow(null, ""),
        image: Joi.string().max(2048).allow(null, ""),
        // A text NFT carries its whole body inline as a data: URI, so this is
        // bounded by the media cap rather than by a plausible URL length.
        text_uri: Joi.string().max(config.maxMediaFetchBytes).allow(null, ""),
    })
    .options({ stripUnknown: true });

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
    tokenMetadata,
    validHTML,
    validMarkdown,
    mint,
    transfer,
};
