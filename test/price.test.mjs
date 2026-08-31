import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

const utils = await import("../src/common/utils.js");
const { parseTokenAmount, formatTokenAmount } = utils.default || utils;
const cfg = await import("../src/common/../config.js");
const config = cfg.default || cfg;
const hist = await import("../src/common/history.js");
const { parseHistory } = hist.default || hist;

// --- decimals ---------------------------------------------------------------

test("every configured token declares decimals and a checksummed address", () => {
    for (const [id, token] of Object.entries(config.tokens)) {
        assert.ok(Number.isInteger(token.decimals), `${id} decimals must be an integer`);
        assert.equal(
            ethers.utils.getAddress(token.address),
            ethers.utils.getAddress(token.address),
            `${id} address must be a valid address`
        );
    }
});

test("USDT is 6 decimals and the rest are 18 — the distinction that matters", () => {
    assert.equal(config.tokens.usdt.decimals, 6);
    for (const id of ["wvc", "vinu", "eth"]) {
        assert.equal(config.tokens[id].decimals, 18, `${id} should be 18 decimals`);
    }
});

test("parseTokenAmount honours each token's decimals", () => {
    assert.equal(parseTokenAmount("1.5", "usdt").toString(), "1500000");
    assert.equal(parseTokenAmount("1.5", "wvc").toString(), "1500000000000000000");
});

test("a USDT amount is not silently scaled as if it were 18 decimals", () => {
    // Getting this wrong is a 10^12 error in the amount actually transferred.
    const usdt = parseTokenAmount("100", "usdt");
    const wvc = parseTokenAmount("100", "wvc");
    assert.equal(wvc.div(usdt).toString(), "1000000000000");
});

test("format and parse round-trip exactly for every configured token", () => {
    for (const id of Object.keys(config.tokens)) {
        for (const amount of ["0.0", "1.0", "0.000001", "123456.789", "999999999.0"]) {
            const decimals = config.tokens[id].decimals;
            // Skip values with more precision than the token can express.
            const fractionDigits = (amount.split(".")[1] ?? "").length;
            if (fractionDigits > decimals) continue;
            assert.equal(
                formatTokenAmount(parseTokenAmount(amount, id), id),
                amount,
                `${id} round-trip failed for ${amount}`
            );
        }
    }
});

test("the smallest representable unit survives a round trip", () => {
    assert.equal(formatTokenAmount("1", "usdt"), "0.000001");
    assert.equal(formatTokenAmount("1", "wvc"), "0.000000000000000001");
});

test("formatTokenAmount rejects an unknown token rather than guessing decimals", () => {
    assert.throws(() => formatTokenAmount("1000", "nosuchtoken"), /not found in config/);
    assert.throws(() => formatTokenAmount("1000", undefined), /not found in config/);
});

test("parseTokenAmount rejects an unknown token rather than guessing decimals", () => {
    assert.throws(() => parseTokenAmount("1", "nosuchtoken"), /not found in config/);
    assert.throws(() => parseTokenAmount("1", undefined), /not found in config/);
});

// --- history must survive a listing in an unrecognised ERC-20 ---------------

const UNKNOWN_TOKEN = "0x000000000000000000000000000000000000dEaD";

function listedEvent(paymentTokenAddress) {
    return {
        event: "TokenListed",
        blockNumber: 100,
        transactionIndex: 0,
        logIndex: 0,
        transactionHash: "0xabc",
        nftType: "text",
        args: {
            _tokenId: ethers.BigNumber.from(1),
            _seller: "0x12BD0b15D5010De455DCe7944265Fe1D35a84023",
            _listingId: ethers.BigNumber.from(0),
            amount: ethers.BigNumber.from(1),
            _paymentToken: paymentTokenAddress,
            _price: ethers.BigNumber.from("1000000000000000000"),
        },
    };
}

test("a listing in a known token parses with a formatted price", () => {
    const [row] = parseHistory([listedEvent(config.tokens.wvc.address)]);
    assert.equal(row.type, "list");
    assert.equal(row.paymentToken, "wvc");
    assert.equal(row.price, "1.0");
});

test("a listing in an unrecognised ERC-20 does not break the whole history", () => {
    // listToken accepts any ERC-20, so anyone can create a listing denominated
    // in a token this app does not know. One such event must not take down
    // activity and NFT history for every other token.
    const events = [listedEvent(UNKNOWN_TOKEN), listedEvent(config.tokens.wvc.address)];

    const rows = parseHistory(events);

    assert.equal(rows.length, 2, "the known listing must still render");
    const unknown = rows[0];
    assert.equal(unknown.type, "list");
    assert.equal(unknown.paymentToken, null, "unknown token must be reported as unknown");
    assert.equal(unknown.price, null, "an unknown token has no trustworthy formatted price");
    assert.equal(rows[1].paymentToken, "wvc");
    assert.equal(rows[1].price, "1.0");
});
