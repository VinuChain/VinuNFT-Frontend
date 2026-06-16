require("dotenv").config({
    path: `.env.${process.env.NODE_ENV}`,
});

module.exports = {
    siteMetadata: {
        siteUrl: "https://www.yourdomain.tld",
        title: "vinu-nft",
    },
    plugins: [
        {
            resolve: "gatsby-source-filesystem",
            options: {
                name: "pages",
                path: "./src/pages/",
            },
            __key: "pages",
        },
        "gatsby-plugin-react-helmet",
        "gatsby-plugin-csp-nonce",
    ],
};
