import { ethers } from "ethers";
import { lag } from "./indexer";
import { loadIndex, profileFromIndex } from "./indexLoader";

/**
 * Everything one address has done with both collections, from the index.
 *
 * This used to walk the latest 12 token ids per type and read balanceOf and
 * authorOf for each. That silently hid every older token: an address whose only
 * NFT was token 1 of a thousand looked like it owned nothing, and there was no
 * way for the page to tell that apart from an empty profile. The index is a
 * fold over each contract's whole life, so every edition, listing and sale is
 * reachable — bounded by the block it was scanned to, which is returned so the
 * page can say so.
 */
export async function loadAddressProfileNfts(readProvider, address) {
    if (!ethers.utils.isAddress(address)) {
        throw new Error("Invalid address");
    }

    const normalizedAddress = ethers.utils.getAddress(address);
    const { state, headBlock } = await loadIndex(readProvider);

    return {
        ...profileFromIndex(state, normalizedAddress),
        indexedThrough: state.lastIndexedBlock,
        lag: lag(state, headBlock),
    };
}
