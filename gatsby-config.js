require("dotenv").config({
    path: `.env.${process.env.NODE_ENV}`,
});

module.exports = {
    siteMetadata: {
        siteUrl: "https://www.yourdomain.tld",
        title: "vinu-nft",
    },
    plugins: [
        // gatsby-source-filesystem is not here: it sourced ./src/pages into
        // GraphQL and nothing in src/ runs a graphql query or useStaticQuery,
        // so it built a node graph no page ever read.
        "gatsby-plugin-react-helmet",
        "gatsby-plugin-csp-nonce",
    ],
};
