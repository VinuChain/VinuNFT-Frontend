import { withTrailingSlash } from "./common/apiRoute";

const config = {
    contractAddresses: {
        v1: {
            text: "0x8974168eC4c942C6D34161e994A759DC3F19b5a8",
            marketplace: "0xcA396A95E0EB8B6804e25F9db131780a60564047",
            image: "0xDE63a95387b89679869591351f5bFD897Dc87DFB",
        },
    },
    // Contract creation blocks, verified against VinuChain by locating each
    // contract's creation transaction (see scripts/verify-deployed-truth.mjs).
    // These bound every historical event scan; a value that is too low costs
    // ~18 extra RPC pages per scan, one that is too high silently loses history.
    firstBlocks: {
        v1: {
            text: 2234593,
            marketplace: 2232125,
            image: 2232056,
        },
    },
    nativeCurrency: {
        name: "VinuCoin",
        symbol: "VC",
        decimals: 18,
    },
    networks: {
        main: {
            name: "Vinu",
            chainId: 207,
        },
        ens: {
            name: "ENS",
            chainId: 1,
        },
        // VinuChain testnet. RECORDED COORDINATES, NOT A NETWORK THIS APP CAN
        // RUN AGAINST: no VinuNFT contract is deployed on chain 206, so
        // contractAddresses/firstBlocks have nothing to say about it and the
        // CSP does not allow its RPC. It is here because the ledger recorded
        // "no reachable VinuChain testnet" as a deployment blocker and that is
        // no longer true — confirmed live 2026-09-02, eth_chainId 0xce, head
        // ~1,603,000. Wiring it as a switchable network needs a deployment
        // first; test/ecosystem.test.mjs holds that door shut.
        testnet: {
            name: "VinuChain Testnet",
            chainId: 206,
            rpc: "https://vinufoundation-rpc.com",
            blockExplorer: "https://testnet.vinuexplorer.org",
        },
    },
    rpc: "https://rpc.vinuchain.org",
    // Largest `toBlock - fromBlock` the RPC will accept for eth_getLogs.
    // Exceeding it fails the whole call with "too wide blocks range".
    //
    // The node applies TWO limits, chosen by the shape of the filter, not by
    // the chain: a request carrying an `address` and/or `topics` gets 100000,
    // a request carrying neither gets 100. Measured 2026-09-02 on both
    // https://rpc.vinuchain.org (chain 207) and https://vinufoundation-rpc.com
    // (chain 206) — the two chains answer identically, so this value is NOT
    // per-network. Every scan in this app filters by contract address (see
    // eventScan.js), which is what buys the 100000; dropping that filter would
    // silently cut the limit by 1000x and turn a ~125-range backfill into
    // ~125,000.
    maxLogBlockRange: 100000,
    // The limit for a request with no `address` and no `topics`. Nothing in
    // this app issues one; it is recorded so the gate in
    // scripts/verify-deployed-truth.mjs can prove the rule still holds.
    maxUnfilteredLogBlockRange: 100,
    api_keys: {
        // Ethereum mainnet, for ENS reverse lookups only (src/common/provider.js).
        // GATSBY_ values are compiled into the public bundle, so this must be a
        // domain-restricted key, never a secret.
        alchemy_mainnet: process.env.GATSBY_ALCHEMY_MAINNET_API_KEY,
    },
    ens: {
        cacheExpiration: 1000 * 60 * 2, // 2 minutes
    },
    blockExplorer: {
        name: "VinuExplorer",
        // Canonical host: https://vinuexplorer.org 301s here, so linking the
        // apex added a redirect to every explorer link the app emits.
        url: "https://mainnet.vinuexplorer.org",
    },
    tokens: {
        wvc: {
            address: "0xEd8c5530a0A086a12f57275728128a60DFf04230",
            decimals: 18,
            symbol: "WVC",
            name: "Wrapped VinuCoin",
        },
        usdt: {
            address: "0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41",
            decimals: 6,
            symbol: "USDT",
            name: "Tether USD",
        },
        vinu: {
            address: "0x00c1E515EA9579856304198EFb15f525A0bb50f6",
            decimals: 18,
            symbol: "VINU",
            name: "Vinu",
        },
        eth: {
            address: "0xDd4b9b3Ce03faAbA4a3839c8B5023b7792be6e2C",
            decimals: 18,
            symbol: "ETH",
            name: "Ethereum",
        },
    },
    standardIpfsGateway: "https://gateway.pinata.cloud/ipfs",
    // Tried in order when resolving an ipfs:// URI, so one gateway being down
    // degrades rather than blanks every image. Also the allowlist of https
    // hosts the app will fetch token media from at all: an NFT URI is
    // attacker-controlled (ImageNFT.mint accepts any string), so fetching
    // arbitrary hosts would turn every viewer's browser into a probe.
    ipfsGateways: ["https://gateway.pinata.cloud/ipfs", "https://ipfs.io/ipfs"],
    // Caps on fetching token media: an unbounded response can exhaust the tab.
    mediaFetchTimeoutMs: 10000,
    maxMediaFetchBytes: 10 * 1024 * 1024,
    // Canonical trailing slash: the deployment 308s `/api/x` to `/api/x/`, and
    // paying that redirect on every upload is a wasted round trip.
    ipfsUploadEndpoint: withTrailingSlash(
        process.env.GATSBY_IPFS_UPLOAD_ENDPOINT || "/api/upload-ipfs"
    ),
    maxIpfsUploadBytes: 10 * 1024 * 1024,
};

function validateConfig(config) {
    for (const contractName of ["text", "image", "marketplace"]) {
        if (!config.contractAddresses.v1[contractName]) {
            throw new Error(
                `Missing VinuNFT contract address: ${contractName}`
            );
        }
        if (!config.firstBlocks.v1[contractName]) {
            throw new Error(`Missing VinuNFT first block: ${contractName}`);
        }
    }
}

validateConfig(config);

export default config;
