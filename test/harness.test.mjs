import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import {
    hasBuild,
    startStaticServer,
    routeOffline,
    installMockWallet,
    chainAnswers,
    answerCall,
    chainReceipt,
    setChainAnswers,
    chainMisses,
    ZERO_WORD,
    TEST_ACCOUNT,
} from "./helpers/browserHarness.mjs";

const SELLER = ethers.utils.getAddress(
    "0x00000000000000000000000000000000000d1ea5"
);
const USDT = "0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41";
const MARKETPLACE = "0xcA396A95E0EB8B6804e25F9db131780a60564047";
const TEXT = "0x8974168eC4c942C6D34161e994A759DC3F19b5a8";

const call = (to, data) => ({ params: [{ to, data }] });

// Encoder shapes first: these need no browser, and a mis-nested return value
// is the failure that would masquerade as "the contract returned zero".

test("chainAnswers encodes a single-tuple output (getListing)", () => {
    const table = chainAnswers([
        {
            to: "marketplace",
            fn: "getListing",
            args: [TEXT, 1, 0],
            returns: [[USDT, "3000000", SELLER, 4]],
        },
    ]);
    const iface = new ethers.utils.Interface([
        "function getListing(address,uint256,uint256) view returns (tuple(address paymentToken,uint256 price,address seller,uint256 amount))",
    ]);
    const data = iface.encodeFunctionData("getListing", [TEXT, 1, 0]);
    const [listing] = iface.decodeFunctionResult(
        "getListing",
        answerCall(table, call(MARKETPLACE, data))
    );

    assert.equal(listing.paymentToken, USDT);
    assert.equal(listing.price.toString(), "3000000");
    assert.equal(listing.amount.toNumber(), 4);
});

test("chainAnswers encodes a two-value output (royaltyInfo)", () => {
    const table = chainAnswers([
        { to: "text", fn: "royaltyInfo", args: [7, 10000], returns: [SELLER, 250] },
    ]);
    const iface = new ethers.utils.Interface([
        "function royaltyInfo(uint256,uint256) view returns (address,uint256)",
    ]);
    const [receiver, quoted] = iface.decodeFunctionResult(
        "royaltyInfo",
        answerCall(table, call(TEXT, iface.encodeFunctionData("royaltyInfo", [7, 10000])))
    );

    assert.equal(receiver, SELLER);
    assert.equal(quoted.toNumber(), 250);
});

test("an argument-free entry answers every call to that function", () => {
    const table = chainAnswers([
        { to: "usdt", fn: "allowance", returns: ["1000000"] },
    ]);
    const iface = new ethers.utils.Interface([
        "function allowance(address,address) view returns (uint256)",
    ]);
    const answer = answerCall(
        table,
        call(
            USDT.toLowerCase(),
            iface.encodeFunctionData("allowance", [TEST_ACCOUNT, MARKETPLACE])
        )
    );

    assert.equal(
        iface.decodeFunctionResult("allowance", answer)[0].toString(),
        "1000000"
    );
});

test("an uncovered call reads as zero and is recorded as a miss", () => {
    const misses = [];
    assert.equal(answerCall({}, call(TEXT, "0xdeadbeef"), misses), ZERO_WORD);
    assert.deepEqual(misses, [`${TEXT.toLowerCase()}:0xdeadbeef`]);
});

let server;
let browser;
let origin;

before(async () => {
    if (!hasBuild) return;
    const { chromium } = await import("playwright");
    ({ server, origin } = await startStaticServer());
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

const balanceOf = new ethers.utils.Interface([
    "function balanceOf(address) view returns (uint256)",
]);

async function openPage(chain) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installMockWallet(page, { chain });
    await routeOffline(page, origin, {
        rpc: { eth_call: (body) => answerCall(chain.answers ?? {}, body) },
    });
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    return { page, context };
}

const request = (page, method, params) =>
    page.evaluate(
        ([method, params]) => window.ethereum.request({ method, params }),
        [method, params]
    );

test(
    "the page answers eth_call from the table and follows a mid-run mutation",
    { skip: !hasBuild },
    async () => {
        const chain = {
            answers: chainAnswers([
                { to: "usdt", fn: "balanceOf", args: [TEST_ACCOUNT], returns: ["5000000"] },
            ]),
        };
        const { page, context } = await openPage(chain);
        try {
            const data = balanceOf.encodeFunctionData("balanceOf", [TEST_ACCOUNT]);
            const read = async () =>
                balanceOf
                    .decodeFunctionResult(
                        "balanceOf",
                        await request(page, "eth_call", [{ to: USDT, data }])
                    )[0]
                    .toString();

            assert.equal(await read(), "5000000");

            await setChainAnswers(
                page,
                chainAnswers([
                    { to: "usdt", fn: "balanceOf", args: [TEST_ACCOUNT], returns: ["1"] },
                ])
            );
            assert.equal(await read(), "1", "the page must reread the table");

            await request(page, "eth_call", [{ to: USDT, data: "0xdeadbeef" }]);
            assert.ok(
                (await chainMisses(page)).includes(`${USDT.toLowerCase()}:0xdeadbeef`),
                "an uncovered call must be recorded"
            );
        } finally {
            await context.close();
        }
    }
);

test(
    "a sent transaction comes back as a formatter-valid transaction and receipt",
    { skip: !hasBuild },
    async () => {
        const chain = {
            answers: {},
            receipt: chainReceipt({
                transferSingle: { nft: "text", to: TEST_ACCOUNT, id: 9, amount: 3 },
            }),
        };
        const { page, context } = await openPage(chain);
        try {
            const hash = await request(page, "eth_sendTransaction", [
                { from: TEST_ACCOUNT, to: TEXT, data: "0x1234", value: "0x0" },
            ]);
            const tx = await request(page, "eth_getTransactionByHash", [hash]);
            const receipt = await request(page, "eth_getTransactionReceipt", [hash]);

            // The real formatter is the only honest judge of "valid enough":
            // _wrapTransaction throws on a missing field or a hash mismatch.
            const formatter = new ethers.providers.Formatter();
            const formattedTx = formatter.transactionResponse(tx);
            assert.equal(formattedTx.hash, hash);
            assert.equal(formattedTx.data, "0x1234");
            assert.equal(formattedTx.nonce, 0);

            const formattedReceipt = formatter.receipt(receipt);
            assert.equal(formattedReceipt.transactionHash, hash);
            assert.equal(formattedReceipt.status, 1);

            const iface = new ethers.utils.Interface([
                "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
            ]);
            const parsed = iface.parseLog(formattedReceipt.logs[0]);
            assert.equal(parsed.name, "TransferSingle");
            assert.equal(parsed.args.from, ethers.constants.AddressZero);
            assert.equal(parsed.args[3].toNumber(), 9);

            const second = await request(page, "eth_sendTransaction", [
                { from: TEST_ACCOUNT, to: TEXT, data: "0x5678", value: "0x0" },
            ]);
            assert.notEqual(second, hash, "two sends need two hashes");

            // A failed transaction is what ethers turns into CALL_EXCEPTION.
            await page.evaluate(() => {
                window.__chainState.receipt.status = "0x0";
            });
            const failed = await request(page, "eth_getTransactionReceipt", [hash]);
            assert.equal(formatter.receipt(failed).status, 0);
        } finally {
            await context.close();
        }
    }
);

test("a pending transaction has no receipt", { skip: !hasBuild }, async () => {
    const { page, context } = await openPage({ answers: {}, receipt: null });
    try {
        const hash = await request(page, "eth_sendTransaction", [
            { from: TEST_ACCOUNT, to: TEXT, data: "0x", value: "0x0" },
        ]);
        assert.equal(await request(page, "eth_getTransactionReceipt", [hash]), null);
        assert.ok(await request(page, "eth_getTransactionByHash", [hash]));
    } finally {
        await context.close();
    }
});

test(
    "ethers itself drives a transaction to a mined receipt through the mock wallet",
    { skip: !hasBuild },
    async () => {
        const { page, context } = await openPage({
            answers: {},
            receipt: chainReceipt({
                transferSingle: { nft: "text", to: TEST_ACCOUNT, id: 4, amount: 1 },
            }),
        });
        try {
            // The bundle does not expose ethers, so load the UMD build. This is
            // the path that hangs on the old harness: JsonRpcSigner polls
            // getTransaction until it is non-null, then _wrapTransaction
            // rejects anything the formatter cannot accept.
            await page.evaluate(
                await readFile("node_modules/ethers/dist/ethers.umd.js", "utf8")
            );
            const result = await page.evaluate(async () => {
                const provider = new window.ethers.providers.Web3Provider(
                    window.ethereum
                );
                const tx = await provider.getSigner().sendTransaction({
                    to: "0x8974168eC4c942C6D34161e994A759DC3F19b5a8",
                    data: "0xabcdef",
                });
                const receipt = await tx.wait(1);
                return {
                    hash: tx.hash,
                    receiptHash: receipt.transactionHash,
                    status: receipt.status,
                    topic: receipt.logs[0].topics[0],
                };
            });

            assert.equal(result.receiptHash, result.hash);
            assert.equal(result.status, 1);
            assert.equal(
                result.topic,
                ethers.utils.id("TransferSingle(address,address,address,uint256,uint256)")
            );
        } finally {
            await context.close();
        }
    }
);
