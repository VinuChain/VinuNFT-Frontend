import { ethers } from "ethers";
import { atom } from "recoil";
import { formatTokenAmount } from "./utils";
import { tokenAddressToId } from "./user";
import { queryFilterChunked } from "./eventScan";

const blockToDateState = atom({
    key: "blockToDateState",
    default: {},
});

/**
 * One normalised record per (id, value) an ERC-1155 transfer log carries.
 *
 * The standard emits two transfer shapes and this app only ever understood
 * TransferSingle, so a `safeBatchTransferFrom` — on both deployed NFT ABIs, so
 * reachable by any holder today — was invisible to history and balances.
 * Expanding here keeps one parser for both shapes rather than teaching every
 * consumer the batch layout.
 *
 * `subIndex` separates the entries of one batch log, which otherwise share a
 * (transactionHash, logIndex) identity and would collapse under any dedup.
 */
const expandTransfers = (event) => {
    const args = event?.args;
    if (!args) {
        return [];
    }

    const base = {
        operator: args.operator,
        from: args.from,
        to: args.to,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        transactionHash: event.transactionHash,
        nftType: event.nftType,
    };

    if (event.event === "TransferSingle") {
        return [{ ...base, id: args.id, value: args.value, subIndex: 0 }];
    }

    if (event.event === "TransferBatch") {
        return args.ids.map((id, subIndex) => ({
            ...base,
            id,
            value: args.values[subIndex],
            subIndex,
        }));
    }

    return [];
};

const getTransferEvents = async (
    id,
    nftContract,
    relevantAddresses,
    firstNftBlock
) => {
    relevantAddresses = [...relevantAddresses];
    const queriedAddresses = [];

    const foundEvents = [];

    const addAddress = (address) => {
        if (
            !relevantAddresses.includes(address) &&
            !queriedAddresses.includes(address) &&
            address != ethers.constants.AddressZero
        ) {
            relevantAddresses.push(address);
        }
    };

    const addEvent = (event) => {
        let eventExists = false;
        for (const foundEvent of foundEvents) {
            if (
                foundEvent.transactionHash == event.transactionHash &&
                foundEvent.logIndex == event.logIndex
            ) {
                eventExists = true;
                break;
            }
        }

        if (!eventExists) {
            foundEvents.push(event);
        }
    };

    while (relevantAddresses.length > 0) {
        const currentRelevantAddresses = [...relevantAddresses];
        relevantAddresses = [];

        const eventPromises = [];

        for (const address of currentRelevantAddresses) {
            // console.log("Querying address", address);
            queriedAddresses.push(address);

            if (address === null) {
                eventPromises.push(
                    queryFilterChunked(
                        nftContract,
                        nftContract.filters.TransferSingle(),
                        firstNftBlock,
                        "latest"
                    ),
                    queryFilterChunked(
                        nftContract,
                        nftContract.filters.TransferBatch(),
                        firstNftBlock,
                        "latest"
                    )
                );
            } else {
                const transferOperatorFilter =
                    nftContract.filters.TransferSingle(address, null, null);
                const transferFromFilter = nftContract.filters.TransferSingle(
                    null,
                    address,
                    null
                );
                const transferToFilter = nftContract.filters.TransferSingle(
                    null,
                    null,
                    address
                );

                // TransferBatch shares TransferSingle's indexed topics
                // (operator, from, to), so the same three positions apply.
                const batchFilters = [
                    nftContract.filters.TransferBatch(address, null, null),
                    nftContract.filters.TransferBatch(null, address, null),
                    nftContract.filters.TransferBatch(null, null, address),
                ];

                for (const filter of [
                    transferOperatorFilter,
                    transferFromFilter,
                    transferToFilter,
                    ...batchFilters,
                ]) {
                    eventPromises.push(
                        queryFilterChunked(
                            nftContract,
                            filter,
                            firstNftBlock,
                            "latest"
                        )
                    );
                }
            }
        }

        const events = await Promise.all(eventPromises);

        for (const eventGroup of events) {
            for (const event of eventGroup) {
                // A batch log carries many ids; `args.id` is undefined on it,
                // so the relevance test has to run over the expansion.
                const relevant = expandTransfers(event).filter(
                    (record) => id === null || record.id == id
                );

                for (const record of relevant) {
                    addAddress(record.from);
                    addAddress(record.to);
                    addAddress(record.operator);
                }

                if (relevant.length > 0) {
                    // The raw log is stored, not the expansion: addEvent dedups
                    // on (transactionHash, logIndex), which every entry of one
                    // batch shares, so storing the expansion would drop all but
                    // the first entry.
                    addEvent(event);
                }
            }
        }
    }

    // console.log("Found events:", foundEvents);

    return foundEvents;
};

const getEvents = async (
    id,
    nftContract,
    marketplaceContract,
    authorAddress,
    firstNftBlock,
    firstMarketplaceBlock
) => {
    const nftAddress = await nftContract.address;
    const tokenListedFilter = marketplaceContract.filters.TokenListed(
        nftAddress,
        id,
        null
    );
    const tokenDelistedFilter = marketplaceContract.filters.TokenDelisted(
        nftAddress,
        id,
        null
    );
    const tokenPurchasedFilter = marketplaceContract.filters.TokenPurchased(
        nftAddress,
        id,
        null,
        null
    );

    const [tokenListedEvents, tokenDelistedEvents, tokenPurchasedEvents] =
        await Promise.all([
            queryFilterChunked(
                marketplaceContract,
                tokenListedFilter,
                firstMarketplaceBlock,
                "latest"
            ),
            queryFilterChunked(
                marketplaceContract,
                tokenDelistedFilter,
                firstMarketplaceBlock,
                "latest"
            ),
            queryFilterChunked(
                marketplaceContract,
                tokenPurchasedFilter,
                firstMarketplaceBlock,
                "latest"
            ),
        ]);

    const relevantAddresses = [authorAddress];

    const addRelevantAddress = (address) => {
        if (
            !relevantAddresses.includes(address) &&
            address != ethers.constants.AddressZero
        ) {
            relevantAddresses.push(address);
        }
    };

    for (const tokenListedEvent of tokenDelistedEvents) {
        addRelevantAddress(tokenListedEvent.args._seller);
    }
    for (const tokenPurchasedEvent of tokenPurchasedEvents) {
        addRelevantAddress(tokenPurchasedEvent.args._buyer);
        addRelevantAddress(tokenPurchasedEvent.args._seller);
    }

    const transferEvents = await getTransferEvents(
        id,
        nftContract,
        relevantAddresses,
        firstNftBlock
    );

    const allEvents = [
        ...tokenListedEvents,
        ...tokenDelistedEvents,
        ...tokenPurchasedEvents,
        ...transferEvents,
    ];

    allEvents.sort((a, b) => {
        const aElements = [a.blockNumber, a.transactionIndex, a.logIndex];
        const bElements = [b.blockNumber, b.transactionIndex, b.logIndex];

        for (let i = 0; i < aElements.length; i++) {
            if (aElements[i] < bElements[i]) {
                return -1;
            } else if (aElements[i] > bElements[i]) {
                return 1;
            }
        }

        return 0;
    });

    return allEvents;
};

const getAllEvents = async (
    nftContract,
    marketplaceContract,
    firstNftBlock,
    firstMarketplaceBlock
) => {
    return await getEvents(
        null,
        nftContract,
        marketplaceContract,
        null,
        firstNftBlock,
        firstMarketplaceBlock
    );
};

const computeBalances = (events) => {
    if (!events) {
        return;
    }

    const balances = {};

    const updateBalance = (address, variation) => {
        if (address == ethers.constants.AddressZero) {
            return;
        }

        if (balances[address] == undefined) {
            balances[address] = 0;
        }

        balances[address] += variation;
    };

    for (const event of events) {
        for (const { from, to, value } of expandTransfers(event)) {
            updateBalance(from, -value.toNumber());
            updateBalance(to, value.toNumber());
        }
    }

    // Filter out addresses with zero balance
    return Object.fromEntries(
        Object.keys(balances)
            .filter((address) => balances[address] != 0)
            .map((address) => [address, balances[address]])
    );
};

const parseHistory = (events) => {
    // console.log("Parsing history for events:", events);
    if (!events) {
        return;
    }
    let parsedEvents = [];

    // console.log(events);

    for (const event of events) {
        switch (event.event) {
            case "TokenListed":
                /*console.log(
                    "Parsing TokenListed event with payment token:",
                    event.args._paymentToken
                );*/
                const listPaymentToken =
                    tokenAddressToId[event.args._paymentToken] ?? null;
                parsedEvents.push({
                    id: parseInt(event.args._tokenId),
                    type: "list",
                    seller: event.args._seller,
                    paymentToken: listPaymentToken,
                    // listToken accepts any ERC-20, so a listing may be
                    // denominated in a token this app does not know. Its
                    // decimals are unknown, so no price can be shown honestly —
                    // but one such listing must not take down history for
                    // every other token, which is what throwing here did.
                    price: listPaymentToken
                        ? formatTokenAmount(
                              event.args._price.toString(),
                              listPaymentToken
                          )
                        : null,
                    amount: event.args.amount.toNumber(), // Note the lack of _
                    transactionHash: event.transactionHash,
                    blockNumber: event.blockNumber,
                    nftType: event.nftType,
                });
                break;
            case "TokenDelisted":
                parsedEvents.push({
                    id: parseInt(event.args._tokenId),
                    type: "delist",
                    seller: event.args._seller,
                    transactionHash: event.transactionHash,
                    blockNumber: event.blockNumber,
                    nftType: event.nftType,
                });
                break;
            case "TransferSingle":
            case "TransferBatch":
                for (const record of expandTransfers(event)) {
                    let transferType = "transfer";
                    if (record.from == ethers.constants.AddressZero) {
                        transferType = "mint";
                    } else if (record.to == ethers.constants.AddressZero) {
                        transferType = "burn";
                    }
                    parsedEvents.push({
                        id: parseInt(record.id),
                        type: transferType,
                        from: record.from,
                        to: record.to,
                        amount: record.value.toNumber(),
                        operator: record.operator,
                        transactionHash: record.transactionHash,
                        blockNumber: record.blockNumber,
                        nftType: record.nftType,
                    });
                }

                break;
            case "TokenPurchased":
                const purchasePaymentToken =
                    tokenAddressToId[event.args._paymentToken] ?? null;
                parsedEvents.push({
                    id: parseInt(event.args._tokenId),
                    type: "purchase",
                    buyer: event.args._buyer,
                    seller: event.args._seller,
                    amount: event.args._amount.toNumber(),
                    paymentToken: purchasePaymentToken,
                    price: purchasePaymentToken
                        ? formatTokenAmount(
                              event.args._price.toString(),
                              purchasePaymentToken
                          ).toString()
                        : null,
                    transactionHash: event.transactionHash,
                    blockNumber: event.blockNumber,
                    nftType: event.nftType,
                });

                break;
            default:
                console.log("Unknown event type: " + event.event);
        }
    }

    for (const event of parsedEvents.filter(
        (event) => event.type == "purchase"
    )) {
        // Filter out transfer and delist events that are part of the same purchase
        parsedEvents = parsedEvents.filter(
            (otherEvent) =>
                !(
                    (otherEvent.type == "transfer" ||
                        otherEvent.type == "delist") &&
                    event.transactionHash == otherEvent.transactionHash
                )
        );
    }

    // console.log(parsedEvents.map((e) => e.type));

    return parsedEvents;
};

const getBlockTime = async (provider, blockNumber) => {
    const block = await provider.getBlock(blockNumber);
    return new Date(parseInt(block.timestamp) * 1000);
};

const getNftAuthor = async (contract, id) => {
    return await contract.authorOf(id);
};

export {
    blockToDateState,
    getBlockTime,
    getNftAuthor,
    getEvents,
    getAllEvents,
    computeBalances,
    parseHistory,
    expandTransfers,
};
