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
    },
    rpc: "https://rpc.vinuchain.org",
    // Largest `toBlock - fromBlock` the RPC will accept for eth_getLogs.
    // Exceeding it fails the whole call with "too wide blocks range".
    maxLogBlockRange: 100000,
    api_keys: {
        alchemy: process.env.GATSBY_ALCHEMY_API_KEY,
        alchemy_mainnet: process.env.GATSBY_ALCHEMY_MAINNET_API_KEY,
        infura: {
            project_id: "0781eeb9a06842599941233024a4218c",
        },
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
    ipfsGateways: [
        "https://gateway.pinata.cloud/ipfs",
        "https://ipfs.io/ipfs",
        "https://cloudflare-ipfs.com/ipfs",
    ],
    // Caps on fetching token media: an unbounded response can exhaust the tab.
    mediaFetchTimeoutMs: 10000,
    maxMediaFetchBytes: 10 * 1024 * 1024,
    ipfsUploadEndpoint:
        process.env.GATSBY_IPFS_UPLOAD_ENDPOINT || "/api/upload-ipfs",
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
