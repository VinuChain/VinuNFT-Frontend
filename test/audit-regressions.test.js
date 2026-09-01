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

    // Every historical scan must go through queryFilterChunked. A raw
    // queryFilter spans millions of blocks and the node rejects it outright
    // ("too wide blocks range"), which silently emptied all history.
    assert.equal(/\.queryFilter\(/.test(history), false);
    assert.equal(history.includes("queryFilterChunked("), true);

    // Total supply is a direct contract read, not a chain-wide mint scan.
    assert.equal(/\.queryFilter\(/.test(nftPage), false);
    assert.equal(nftPage.includes("nftContract.totalSupply(id)"), true);
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
    assert.equal(nativeCurrencyCount, 1);

    // Contract creation blocks, each verified on VinuChain by locating the
    // creation transaction. They were previously all pinned to 467700, which
    // predates every deployment by ~1.76M blocks. scripts/verify-deployed-truth.mjs
    // re-checks these against the chain.
    assert.equal(config.includes("text: 2234593"), true);
    assert.equal(config.includes("marketplace: 2232125"), true);
    assert.equal(config.includes("image: 2232056"), true);
    assert.equal(config.includes("467700"), false);
});

test("NFT ABIs describe the deployed contracts, not newer source", () => {
    // ethers resolves `.totalSupply(id)` by name; a zero-arg overload in the
    // ABI would make that call ambiguous and throw. The deployed contracts do
    // not implement one, so it must not appear in the ABI either.
    for (const name of ["TextNFT", "ImageNFT"]) {
        const abiFile = JSON.parse(read(`src/abis/${name}.json`));
        const abi = abiFile.abi ?? abiFile;
        const supplyFns = abi.filter(
            (x) => x.type === "function" && x.name === "totalSupply"
        );
        assert.equal(
            supplyFns.length,
            1,
            `${name} must declare one totalSupply`
        );
        assert.equal(supplyFns[0].inputs.length, 1);
        assert.equal(supplyFns[0].inputs[0].type, "uint256");
    }
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
    ].forEach((url) => {
        assert.equal(wrapper.includes(url), true);
    });

    // The explorer link comes from the registry rather than a literal: the
    // footer previously pointed at a different host from every other explorer
    // link in the app. test/ecosystem.test.mjs asserts no source file outside
    // src/config.js hard-codes an ecosystem identifier.
    assert.equal(wrapper.includes("config.blockExplorer.url"), true);
    assert.equal(wrapper.includes("vinuexplorer.org"), false);
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
    // The editor preview and the published render now share one plugin list
    // (src/common/sanitize.js) rather than each naming the schema separately.
    // test/sanitize.test.mjs proves they produce byte-identical output and that
    // both neutralise every adversarial fixture.
    assert.equal(multiEditor.includes("markdownRehypePlugins()"), true);
    assert.equal(multiEditor.includes("rehypeSanitize"), false);

    const sanitize = read("src/common/sanitize.js");
    assert.equal(sanitize.includes("schemas.validMarkdown"), true);
    assert.equal(sanitize.includes("schemas.validHTML"), true);

    // Both viewers must go through that module, not build their own pipeline.
    for (const viewer of ["MarkdownViewer", "HTMLViewer"]) {
        const source = read(`src/components/${viewer}.js`);
        assert.equal(
            source.includes("unified()"),
            false,
            `${viewer} must not build its own pipeline`
        );
        assert.equal(source.includes("common/sanitize"), true);
        // Sanitised output is still rendered into a sandboxed iframe. The
        // value matters: a bare `sandbox` is `sandbox={true}` in JSX, which
        // React drops for a non-boolean attribute, so the frame shipped with
        // no sandbox at all. test/nftDetail.test.mjs asserts the attribute
        // that actually reaches the DOM; this only stops the source from
        // regressing to a form that silently emits nothing.
        assert.equal(source.includes('sandbox="allow-same-origin"'), true);
    }
});

test("no unread third-party account id ships in the client config", () => {
    // `infura.project_id` was a hardcoded account identifier with no reader
    // anywhere in the repo, inlined verbatim into the browser bundle.
    // tsx transpiles src/config.js to CommonJS, so the default export is
    // where the object lands (same idiom as the .mjs suites).
    const configModule = require("../src/config");
    const { api_keys: apiKeys } = configModule.default || configModule;
    assert.equal(
        "infura" in apiKeys,
        false,
        "no unread third-party account id may ship in the client config"
    );
    for (const [name, value] of Object.entries(apiKeys)) {
        assert.equal(
            typeof value === "string" && value.length > 0,
            false,
            `${name} must come from the environment, not a literal in config.js`
        );
    }

    // GATSBY_ values are compiled into the bundle. Only PINATA_API_JWT carried
    // a warning, so the Alchemy keys read like secrets an operator must guard.
    assert.match(read(".env.example"), /GATSBY_.*public browser bundle/is);
});

test("marketplace discovery reads the index and stays linked", () => {
    const design = read("docs/marketplace-discovery.md");
    const helper = read("src/common/marketplaceDiscovery.js");
    const page = read("src/pages/marketplace.js");
    const header = read("src/components/Header.js");

    // The window was replaced, not merely widened: the route reads the index,
    // and the doc has to describe that rather than the bounded MVP it dropped.
    assert.equal(design.includes("reads the **index**"), true);
    assert.equal(design.includes("## RPC Cost"), true);
    assert.equal(page.includes("indexLoader"), true);
    assert.equal(page.includes("MARKETPLACE_DISCOVERY_WINDOW"), false);
    assert.equal(helper.includes("queryFilter"), false);
    assert.equal(page.includes("Marketplace - VinuNFT"), true);
    assert.equal(
        page.includes("/nft?type=${listing.nftType}&id=${listing.tokenId}"),
        true
    );
    assert.equal(page.includes("Fulfillable"), true);
    assert.equal(page.includes("No listings"), true);
    assert.equal(header.includes("/marketplace"), true);

    // One filter implementation. The page reached the module's predicates
    // rather than keeping a second copy that disagreed on an unknown balance.
    assert.equal(page.includes("rowMatchesFilters"), true);
    assert.equal(page.includes("pageListings"), true);

    // Analytics live outside the discovery helper, which this file also pins
    // free of queryFilter, and every definition is written down beside them.
    const analytics = read("src/common/marketplaceAnalytics.js");
    assert.equal(helper.includes("marketplaceMetrics"), false);
    assert.equal(design.includes("## Metric Definitions"), true);
    assert.equal(design.includes("### What is deliberately NOT shown"), true);

    // No cross-currency aggregate anywhere: every money figure is keyed by
    // payment token, and a total across tokens has no definition without a
    // price oracle this product does not have.
    assert.equal(analytics.includes("byPaymentToken"), true);
    assert.equal(analytics.includes("totalVolume"), false);
});

test("address profiles validate addresses and preserve explorer access", () => {
    const design = read("docs/address-profiles.md");
    const helper = read("src/common/addressProfile.js");
    const page = read("src/pages/address.js");
    const address = read("src/components/Address.js");

    assert.equal(design.includes("/address?address=0x"), true);
    assert.equal(design.includes("## Index Strategy"), true);
    assert.equal(helper.includes("loadIndex"), true);
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

test("CSP policy in add_csp.js includes required restrictive directives", () => {
    const cspScript = read("add_csp.js");

    // These directives must be present to provide meaningful CSP protection.
    // If any of these regress, the app's Content Security Policy is weakened.
    assert.equal(cspScript.includes("object-src 'none'"), true);
    assert.equal(cspScript.includes("base-uri 'self'"), true);
    assert.equal(cspScript.includes("default-src 'self'"), true);
    assert.equal(cspScript.includes("frame-ancestors 'self'"), true);
    // img-src must permit blob:, which is how token images reach <img> after
    // being fetched with a byte cap via URL.createObjectURL.
    assert.equal(cspScript.includes("blob:"), true);

    // connect-src must cover the VinuChain RPC, which is still listed here.
    assert.equal(cspScript.includes("https://rpc.vinuchain.org"), true);

    // IPFS gateway origins are no longer duplicated here: they are read from
    // src/config.js, because a hard-coded copy silently blocked whichever
    // gateways config added later. test/csp.test.mjs asserts the *built*
    // policy actually allows every configured gateway, which is stronger than
    // matching a literal in this file.
    assert.equal(cspScript.includes("ipfsGatewayOrigins()"), true);
    assert.equal(cspScript.includes('"https://gateway.pinata.cloud"'), false);
});

test("markdown NFT rendering is sandboxed via MarkdownViewer, not bare MDEditor", () => {
    const nftCard = read("src/components/NFTCard.js");
    const nftPage = read("src/pages/nft/index.js");
    const schemas = read("src/common/schemas.js");

    // Both render sites must reference MarkdownViewer (sandboxed iframe)
    assert.equal(nftCard.includes("MarkdownViewer"), true);
    assert.equal(nftPage.includes("MarkdownViewer"), true);

    // Neither render site may use bare MDEditor.Markdown for third-party content
    // (bare MDEditor.Markdown with rehypeSanitize(schemas.validMarkdown) is the old unsandboxed pattern)
    assert.equal(
        nftCard.includes("rehypeSanitize(schemas.validMarkdown)"),
        false
    );
    assert.equal(
        nftPage.includes("rehypeSanitize(schemas.validMarkdown)"),
        false
    );

    // validMarkdown must no longer add "data" to protocols.src
    const validMarkdownSection = schemas.slice(
        schemas.indexOf("const validMarkdown")
    );
    assert.equal(
        validMarkdownSection
            .slice(0, validMarkdownSection.indexOf("const validHTML"))
            .includes('"data"'),
        false
    );
});

test("NFT preview cards and image detail views stay keyboard and screen-reader accessible", () => {
    const nftCard = read("src/components/NFTCard.js");
    const nftPage = read("src/pages/nft/index.js");

    assert.equal(nftCard.includes("RoutingLink"), false);
    assert.equal(nftCard.includes('role="link"'), true);
    assert.equal(nftCard.includes("tabIndex={0}"), true);
    assert.equal(nftCard.includes("onKeyDown={handleCardKeyDown}"), true);
    assert.equal(nftCard.includes('event.key === "Enter"'), true);
    assert.equal(nftCard.includes('event.key === " "'), true);
    assert.equal(nftCard.includes("aria-label={`View ${tokenLabel}`}"), true);
    assert.equal(nftCard.includes("imageAltText"), true);
    assert.equal(nftCard.includes("alt={imageAltText}"), true);
    assert.equal(nftPage.includes("imageAltText"), true);
    assert.equal(nftPage.includes("alt={imageAltText}"), true);
});
