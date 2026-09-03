import { useEffect } from "react";
import { ethers } from "ethers";
import { atom, useRecoilState } from "recoil";
import { v1 } from "./abi";
import config from "../config";
import { formatError } from "./error";
import { defaultReadProvider } from "./provider";

/** The deployed contracts, by the address a receipt log carries. */
const INTERFACES = Object.fromEntries(
    Object.entries(config.contractAddresses.v1).map(([name, address]) => [
        address.toLowerCase(),
        new ethers.utils.Interface(v1[name]),
    ])
);

/**
 * A provider receipt, given the `events` array `tx.wait()` would have attached.
 *
 * A receipt fetched from the node carries raw logs; only a receipt that came
 * back through a contract's `wait()` has them parsed. Callers — the mint flow
 * above all — read `receipt.events` to learn WHICH token was minted, so a
 * receipt without them reports a success it cannot describe. Decoding here, at
 * the one seam that produces a raw receipt, keeps a single decoding path.
 *
 * Unparseable logs are kept as they arrived, exactly as ethers does: a log from
 * another contract is not ours to describe, and dropping it would make the
 * receipt lie about what the transaction did.
 */
const withParsedEvents = (receipt) => {
    if (!receipt || receipt.events) {
        return receipt;
    }
    const events = (receipt.logs ?? []).map((log) => {
        const iface = INTERFACES[String(log.address).toLowerCase()];
        if (!iface) {
            return log;
        }
        try {
            const parsed = iface.parseLog(log);
            return {
                ...log,
                event: parsed.name,
                eventSignature: parsed.signature,
                args: parsed.args,
            };
        } catch (e) {
            return log;
        }
    });
    return { ...receipt, events };
};

const transactionStatusState = atom({
    key: "transactionStatus",
    default: {},
});

const transactionListenersState = atom({
    key: "transactionListeners",
    default: [],
});

// Transaction status schema:
/*
{
    status: 'pending' | 'approved' | 'success' | 'error',
    name: string,
    content [optional]: any,
    url [optional]: string,
    hash: string,
    errorMessage [only if status == 'error']: string
}
*/
// Pending = not approved yet
// Approved = Approved, not inserted yet

const TRANSACTION_STORAGE_KEY = "vinunft.transactions";
// A day is long enough to cover a reload mid-transaction and short enough that
// the key cannot grow without bound over a browser's lifetime.
const TRANSACTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const pruneTransactions = (stored, now) =>
    Object.fromEntries(
        Object.entries(stored ?? {}).filter(
            ([, entry]) =>
                entry &&
                typeof entry.updatedAt === "number" &&
                now - entry.updatedAt < TRANSACTION_MAX_AGE_MS
        )
    );

/**
 * What a stored entry becomes once the chain has been asked about it.
 * `null` means "no news" — an absent receipt is a transaction still in the
 * mempool, which must stay pending rather than be reported as failed.
 */
const statusFromReceipt = (entry, receipt) => {
    if (!receipt) {
        return null;
    }
    if (receipt.status === 0) {
        return {
            ...entry,
            status: "error",
            errorMessage: "Transaction reverted on chain.",
        };
    }
    return { ...entry, status: "success" };
};

const readStoredTransactions = () => {
    if (typeof window === "undefined" || !window.localStorage) {
        return {};
    }
    try {
        return pruneTransactions(
            JSON.parse(window.localStorage.getItem(TRANSACTION_STORAGE_KEY)),
            Date.now()
        );
    } catch {
        return {};
    }
};

/**
 * Pure: what the store holds after one status change.
 *
 * Only UNRESOLVED transactions are kept. Restoration replays every stored entry
 * into a toast, so keeping a finished one raised its "Transaction mined" toast
 * again on every reload for the next 24 hours, as though it had just happened —
 * and there is nothing left to re-resolve either way.
 */
const nextStoredTransactions = (stored, transactionId, status, now) => {
    const next = { ...stored };
    if (status.status === "success" || status.status === "error") {
        delete next[transactionId];
        return next;
    }
    const previous = stored[transactionId];
    next[transactionId] = {
        id: Number(transactionId),
        name: status.name,
        status: status.status,
        hash: status.hash,
        errorMessage: status.errorMessage,
        // Age is measured from the last real change, not from the last
        // write. Restoring rewrites every entry, so a `now` here
        // would keep a transaction that never mines alive forever.
        updatedAt:
            previous && previous.status === status.status
                ? previous.updatedAt
                : now,
    };
    return next;
};

const writeStoredTransaction = (transactionId, status) => {
    // Only a transaction that reached the chain is worth restoring: without a
    // hash there is nothing to re-resolve, and the wallet prompt it was
    // waiting on died with the page.
    if (typeof window === "undefined" || !window.localStorage || !status.hash) {
        return;
    }
    try {
        window.localStorage.setItem(
            TRANSACTION_STORAGE_KEY,
            JSON.stringify(
                nextStoredTransactions(
                    readStoredTransactions(),
                    transactionId,
                    status,
                    Date.now()
                )
            )
        );
    } catch {
        // A full or blocked localStorage must not break the transaction the
        // user is actually running.
    }
};

/**
 * Re-resolve the transactions a reload interrupted, all at once.
 *
 * `tx.wait()` died with the page, so nothing else is watching these. A single
 * `getTransactionReceipt` is not enough: a transaction still in the mempool has
 * no receipt yet, and the recovery used to end there and leave the notification
 * "approved" forever even after it mined. `waitForTransaction` keeps asking.
 *
 * In parallel, because one transaction that never mines would otherwise starve
 * every entry behind it, and bounded, because a dropped transaction would poll
 * for the life of the tab. On timeout the entry stays pending — an outcome we
 * do not know is not an outcome — and the next reload picks it up again, since
 * only unresolved transactions are stored.
 */
const RESTORE_WATCH_MS = 10 * 60 * 1000;

const restoreUnresolved = (entries, provider, update) =>
    Promise.all(
        entries
            .filter(
                (entry) =>
                    entry.status === "pending" || entry.status === "approved"
            )
            .map(async (entry) => {
                try {
                    const resolved = statusFromReceipt(
                        entry,
                        await provider.waitForTransaction(
                            entry.hash,
                            1,
                            RESTORE_WATCH_MS
                        )
                    );
                    if (resolved) {
                        update(entry.id, resolved);
                    }
                } catch (e) {
                    // An unreachable RPC or an expired watch leaves the entry
                    // pending, which is the honest answer: we do not know the
                    // outcome.
                    console.log(e);
                }
            })
    );

// Restoring is once per page, not once per component: every component that
// calls this hook would otherwise replay the same toasts.
let restoredFromStorage = false;

const useTransactionStatus = () => {
    const [transactionsStatus, setTransactionsStatus] = useRecoilState(
        transactionStatusState
    );

    const [transactionListeners, setTransactionListeners] = useRecoilState(
        transactionListenersState
    );

    const register = (listener) => {
        setTransactionListeners((transactionListeners) => {
            if (transactionListeners.includes(listener)) {
                return transactionListeners;
            }
            return [...transactionListeners, listener];
        });
    };

    const updateTransactionStatus = async (transactionId, status) => {
        setTransactionsStatus((currentTransactionStatus) => ({
            ...currentTransactionStatus,
            [transactionId]: status,
        }));

        writeStoredTransaction(transactionId, status);

        for (const listener of transactionListeners) {
            listener(transactionId, status);
        }
    };

    // Waits for a listener, because a replay into an empty listener list is
    // silently lost and the reloaded page shows nothing.
    useEffect(() => {
        if (restoredFromStorage || transactionListeners.length === 0) {
            return;
        }
        restoredFromStorage = true;

        const stored = readStoredTransactions();
        const entries = Object.values(stored);
        if (entries.length === 0) {
            return;
        }

        // New transactions must not reuse a restored id: the id is also the
        // toast id, so a collision overwrites the restored notification.
        nextTransactionId = Math.max(
            nextTransactionId,
            ...entries.map((entry) => entry.id + 1)
        );

        for (const entry of entries) {
            updateTransactionStatus(entry.id, entry);
        }

        restoreUnresolved(
            entries,
            defaultReadProvider,
            updateTransactionStatus
        );
    }, [transactionListeners]);

    const getTransactionStatus = (transactionId) => {
        return transactionsStatus[transactionId];
    };

    const getTransactions = () => {
        return transactionsStatus;
    };

    return {
        getTransactionStatus,
        transactions: transactionsStatus,
        updateTransactionStatus,
        register,
    };
};

/**
 * ethers throws TRANSACTION_REPLACED out of tx.wait() whenever the wallet
 * speeds up, cancels or replaces a pending transaction. A speed-up ("repriced")
 * carries out the same intent and mines, so reporting it as a failure invites
 * the user to pay for the same NFT twice. Kept pure so the branches are
 * testable without block-replacement machinery.
 */
const classifyTransactionError = (e, transaction) => {
    if (e?.code === "TRANSACTION_REPLACED") {
        const hash = e.replacement?.hash;
        // The replacement is the transaction that MINED. Content functions
        // render their own explorer link from `transaction.hash` — the mint one
        // does — so describing the superseded original sends the user to a hash
        // the chain does not have.
        const replacement = hash ? { ...transaction, hash } : transaction;
        if (e.reason === "repriced") {
            // This receipt comes straight from the provider, not from a
            // contract's wait(), so its logs are raw — and every content
            // function reads the parsed `events` array unguarded.
            return {
                status: "success",
                hash,
                transaction: replacement,
                receipt: withParsedEvents(e.receipt) ?? { events: [] },
            };
        }
        return {
            status: "error",
            hash,
            transaction: replacement,
            errorMessage:
                e.reason === "cancelled"
                    ? "Transaction cancelled from your wallet."
                    : "Transaction replaced from your wallet.",
        };
    }

    return { status: "error", transaction, errorMessage: formatError(e) };
};

let nextTransactionId = 0;

const useTransactionHelper = () => {
    const { updateTransactionStatus } = useTransactionStatus();
    const newId = () => nextTransactionId++;

    const handleTransaction = async (
        transactionFunction,
        transactionName,
        contentFunction,
        rethrow
    ) => {
        const transactionId = newId();
        let transaction;
        try {
            updateTransactionStatus(transactionId, {
                status: "pending",
                name: transactionName,
                content: contentFunction
                    ? await contentFunction("pending")
                    : null,
            });
            transaction = await transactionFunction();
            updateTransactionStatus(transactionId, {
                status: "approved",
                name: transactionName,
                hash: transaction.hash,
                content: contentFunction
                    ? await contentFunction("approved", transaction)
                    : null,
            });

            const receipt = await transaction.wait(1);

            updateTransactionStatus(transactionId, {
                status: "success",
                name: transactionName,
                hash: transaction.hash,
                content: contentFunction
                    ? await contentFunction(
                          "success",
                          transaction,
                          true,
                          receipt
                      )
                    : null,
            });

            return {
                transaction,
                receipt,
                success: true,
            };
        } catch (e) {
            // `mined` is the original unless the wallet replaced it, in which
            // case it is the transaction that actually reached the chain.
            const {
                status,
                hash,
                errorMessage,
                receipt,
                transaction: mined,
            } = classifyTransactionError(e, transaction);

            if (status === "success") {
                updateTransactionStatus(transactionId, {
                    status: "success",
                    name: transactionName,
                    hash,
                    content: contentFunction
                        ? await contentFunction("success", mined, true, receipt)
                        : null,
                });
                return { transaction: mined, receipt, success: true };
            }

            console.log(e);
            updateTransactionStatus(transactionId, {
                status: "error",
                name: transactionName,
                hash: hash ?? transaction?.hash,
                errorMessage,
                content: contentFunction
                    ? await contentFunction("success", mined, false)
                    : null,
            });

            if (rethrow) {
                throw e;
            }

            return {
                error: e,
                success: false,
            };
        }
    };
    return handleTransaction;
};

export {
    useTransactionStatus,
    nextStoredTransactions,
    restoreUnresolved,
    RESTORE_WATCH_MS,
    useTransactionHelper,
    classifyTransactionError,
    pruneTransactions,
    statusFromReceipt,
    TRANSACTION_STORAGE_KEY,
    TRANSACTION_MAX_AGE_MS,
};
