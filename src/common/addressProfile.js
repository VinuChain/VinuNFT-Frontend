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

/**
 * How many cards one profile section renders before the visitor asks for more.
 *
 * Each card independently reads its URI and its author and may then fetch
 * metadata and media, so a section is not a list of rows but a list of request
 * fans. An address with a few hundred tokens mounted every one of them at once,
 * which is thousands of simultaneous RPC and gateway requests — enough to be
 * throttled, and a throttled `authorOf` is what withholds a listing.
 */
export const PROFILE_PAGE_SIZE = 24;

/** A bounded page of one section, and how many it is not showing. */
export function profileSection(refs, shown = PROFILE_PAGE_SIZE) {
    const rows = (refs ?? []).slice(0, Math.max(shown, 0));
    return { rows, remaining: (refs ?? []).length - rows.length };
}
