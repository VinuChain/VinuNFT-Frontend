const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
    fs.readFileSync(path.join(root, relativePath), "utf8");

test("Pinata credentials stay out of the browser bundle", () => {
    const clientIpfs = read("src/common/ipfs.js");
    const uploadFunction = read("src/api/upload-ipfs.js");
    const publicMintingDesign = read("docs/public-image-minting-access.md");
    const readme = read("README.md");

    assert.equal(clientIpfs.includes("PinataSDK"), false);
    assert.equal(clientIpfs.includes("GATSBY_PINATA_API_JWT"), false);
    assert.equal(uploadFunction.includes("PINATA_API_JWT"), true);
    assert.equal(uploadFunction.includes("MAX_UPLOAD_BYTES"), true);
    assert.equal(uploadFunction.includes("export const config"), true);
    assert.equal(uploadFunction.includes("verifyMessage"), true);
    assert.equal(uploadFunction.includes("RATE_LIMIT_WINDOW_MS"), true);
    assert.equal(
        uploadFunction.includes("PINATA_ALLOWED_UPLOAD_ADDRESSES"),
        true
    );
    assert.equal(
        uploadFunction.includes("MAX_GLOBAL_UPLOADS_PER_WINDOW"),
        true
    );
    assert.equal(/process\.env\.PINATA_/.test(uploadFunction), false);
    assert.equal(publicMintingDesign.includes("Recommended MVP"), true);
    assert.equal(
        publicMintingDesign.includes("PINATA_API_JWT remains server-only"),
        true
    );
    assert.equal(publicMintingDesign.includes("recent wallet signature"), true);
    assert.equal(
        readme.includes("Public image minting requires durable"),
        true
    );
});

test("legacy PHP social preview route is removed", () => {
    const socialDesign = read("docs/social-preview-design.md");
    const nftPage = read("src/pages/nft/index.js");

    assert.equal(fs.existsSync(path.join(root, "static/social.php")), false);
    assert.equal(fs.existsSync(path.join(root, "static/Keccak.php")), false);
    assert.equal(read("postbuild.py").includes("index.php"), true);
    assert.equal(read("postbuild.py").includes("file_get_contents"), false);
    assert.equal(socialDesign.includes("First slice"), true);
    assert.equal(socialDesign.includes("static safe metadata"), true);
    assert.equal(nftPage.includes("og:title"), true);
    assert.equal(nftPage.includes("twitter:card"), true);
    assert.equal(nftPage.includes("socialDescription"), true);
});

test("history parsing uses TokenPurchased payment tokens directly", () => {
    const history = read("src/common/history.js");

    assert.equal(
        history.includes("tokenAddressToId[event.args._paymentToken]"),
        true
    );
    assert.equal(history.includes("paymentTokens["), false);
});

test("event scans and author lookups are bounded/direct", () => {
    const history = read("src/common/history.js");
    const nftPage = read("src/pages/nft/index.js");

    assert.equal(history.includes("queryFilter(allTransfersFilter));"), false);
    assert.equal(
        history.includes("contract.queryFilter(transferFromFilter)"),
        false
    );
    assert.equal(history.includes("return await contract.authorOf(id);"), true);
    assert.equal(nftPage.includes('["totalSupply(uint256)"]'), false);
    assert.equal(nftPage.includes('"latest"'), true);
});

test("buy modal handles loading balances and insufficient funds", () => {
    const buyModal = read("src/components/BuyModal.js");

    assert.equal(buyModal.includes("paymentTokenBalance.toString()"), false);
    assert.equal(buyModal.includes("paymentTokenBalance !== null"), true);
    assert.equal(buyModal.includes("Insufficient balance"), true);
});

test("provider listener cleanup cannot remove the wrong listener", () => {
    const provider = read("src/common/provider.js");

    assert.equal(provider.includes("splice"), false);
    assert.equal(provider.includes("new Set()"), true);
    assert.equal(provider.includes("listeners.delete(forceUpdate)"), true);
});

test("VinuChain config is normalized", () => {
    const config = read("src/config.js");
    const nativeCurrencyCount = config.match(/nativeCurrency:/g)?.length || 0;

    assert.equal(config.includes("iamge"), false);
    assert.equal(config.includes("image: 467700"), true);
    assert.equal(nativeCurrencyCount, 1);
});

test("footer links to the VinuChain ecosystem socials", () => {
    const wrapper = read("src/Wrapper.js");

    assert.equal(
        wrapper.includes('content="width=device-width, initial-scale=1"'),
        true
    );

    [
        "https://github.com/VinuChain",
        "https://twitter.com/vinuchain",
        "https://discord.gg/vinu",
        "https://t.me/vitainu",
        "https://medium.com/vinuchain",
        "https://mainnet.vinuexplorer.org",
    ].forEach((url) => {
        assert.equal(wrapper.includes(url), true);
    });
});

test("header exposes branded navigation and accessible mobile menu state", () => {
    const header = read("src/components/Header.js");

    assert.equal(header.includes("VinuChain mainnet"), true);
    assert.equal(header.includes('href: "/marketplace"'), true);
    assert.equal(header.includes('href: "/bridge"'), true);
    assert.equal(header.includes('aria-controls="vinunft-navbar"'), true);
    assert.equal(header.includes("aria-expanded={isActive}"), true);
    assert.equal(header.includes("vinunft-header__nav-link"), true);
});

test("HTML sanitization does not allow style or data URL expansion", () => {
    const schemas = read("src/common/schemas.js");
    const validHtml = schemas.slice(schemas.indexOf("const validHTML"));
    const mint = read("src/pages/mint.js");
    const multiEditor = read("src/components/MultiEditor.js");
    const richTextDesign = read("docs/rich-text-minting.md");

    assert.equal(validHtml.includes('"style"'), false);
    assert.equal(validHtml.includes('"data"'), false);
    assert.equal(richTextDesign.includes("Enable markdown first"), true);
    assert.equal(mint.includes('value="text/markdown"'), true);
    assert.equal(mint.includes('value="text/html"'), false);
    assert.equal(mint.includes("Markdown is sanitized"), true);
    assert.equal(
        multiEditor.includes("rehypeSanitize(schemas.validMarkdown)"),
        true
    );
});

test("marketplace discovery stays bounded and linked", () => {
    const design = read("docs/marketplace-discovery.md");
    const helper = read("src/common/marketplaceDiscovery.js");
    const page = read("src/pages/marketplace.js");
    const header = read("src/components/Header.js");

    assert.equal(design.includes("client-only MVP"), true);
    assert.equal(design.includes("Maximum RPC call count"), true);
    assert.equal(helper.includes("MARKETPLACE_DISCOVERY_WINDOW"), true);
    assert.equal(helper.includes("MARKETPLACE_LISTINGS_PER_TOKEN_LIMIT"), true);
    assert.equal(helper.includes("queryFilter"), false);
    assert.equal(page.includes("Marketplace - VinuNFT"), true);
    assert.equal(
        page.includes("/nft?type=${listing.nftType}&id=${listing.tokenId}"),
        true
    );
    assert.equal(page.includes("Fulfillable"), true);
    assert.equal(page.includes("No listings"), true);
    assert.equal(header.includes("/marketplace"), true);
});

test("address profiles validate addresses and preserve explorer access", () => {
    const design = read("docs/address-profiles.md");
    const helper = read("src/common/addressProfile.js");
    const page = read("src/pages/address.js");
    const address = read("src/components/Address.js");

    assert.equal(design.includes("/address?address=0x"), true);
    assert.equal(design.includes("Maximum RPC call count"), true);
    assert.equal(helper.includes("ADDRESS_PROFILE_WINDOW"), true);
    assert.equal(helper.includes("queryFilter"), false);
    assert.equal(page.includes("Address - VinuNFT"), true);
    assert.equal(page.includes("Invalid address"), true);
    assert.equal(page.includes("ethers.utils.isAddress"), true);
    assert.equal(page.includes("blockExplorer.url"), true);
    assert.equal(page.includes("NFTCard"), true);
    assert.equal(address.includes("disableLink"), true);
    assert.equal(address.includes("/address?address="), true);
    assert.equal(address.includes("blockExplorer.url"), true);
});

test("WanBridge port uses VinuNFT proxies and validated transaction creation", () => {
    const bridge = read("src/pages/bridge.js");
    const model = read("src/common/wanbridge.js");
    const validation = read("src/common/wanbridgeValidation.js");
    const createTx = read("src/api/wanbridge-create-tx.js");
    const tokenPairs = read("src/api/wanbridge-token-pairs.js");
    const quota = read("src/api/wanbridge-quota-and-fee.js");
    const buyModal = read("src/components/BuyModal.js");
    const listModal = read("src/components/ListModal.js");

    assert.equal(bridge.includes("li.finance"), false);
    assert.equal(model.includes('WANBRIDGE_PARTNER = "VinuNFT"'), true);
    assert.equal(model.includes('VINUCHAIN_CHAIN_TYPE = "VC"'), true);
    assert.equal(model.includes("buildVinuChainRoutes"), true);
    assert.equal(bridge.includes("/api/wanbridge-token-pairs"), true);
    assert.equal(bridge.includes("/api/wanbridge-quota-and-fee"), true);
    assert.equal(bridge.includes("/api/wanbridge-create-tx"), true);
    assert.equal(bridge.includes("wallet_switchEthereumChain"), true);
    assert.equal(bridge.includes("wallet_addEthereumChain"), true);
    assert.equal(bridge.includes("approveCheck"), true);
    assert.equal(bridge.includes("sendTransaction"), true);
    assert.equal(bridge.includes("Bridge with WanBridge"), true);
    assert.equal(bridge.includes("Open WanBridge"), true);
    assert.equal(tokenPairs.includes("applyApiRateLimit"), true);
    assert.equal(quota.includes("applyApiRateLimit"), true);
    assert.equal(createTx.includes("applyApiRateLimit"), true);
    assert.equal(createTx.includes("ethers.utils.isAddress"), true);
    assert.equal(createTx.includes("isDestinationAccount"), true);
    assert.equal(createTx.includes("isTokenIdentifier"), true);
    assert.equal(createTx.includes("isPositiveDecimal"), true);
    assert.equal(validation.includes("BNB;DROP"), false);
    assert.equal(validation.includes("isChainType"), true);
    assert.equal(validation.includes("isDestinationAccount"), true);
    assert.equal(validation.includes("isTokenIdentifier"), true);
    assert.equal(buyModal.includes("BridgeShortcut"), true);
    assert.equal(buyModal.includes("Insufficient balance"), true);
    assert.equal(listModal.includes("BridgeShortcut"), true);
    assert.equal(listModal.includes("Buyers can bridge"), true);
});
