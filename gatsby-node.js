const webpack = require("webpack");

exports.onCreateWebpackConfig = ({ stage, actions }) => {
    actions.setWebpackConfig({
        resolve: {
            // No `resolve.fallback` here on purpose. It declared browser
            // shims for 13 Node builtins; a fallback only activates when some
            // module actually requests the builtin, and none did — the shims
            // appeared in zero of the emitted sourcemaps while dragging
            // express, body-parser, node-forge and elliptic into a browser
            // project's audited dependency tree. Webpack names the requester
            // ("Can't resolve 'crypto' in ...") if one ever appears, so the
            // build itself is the check.
        },
        plugins: [
            new webpack.ProvidePlugin({
                // Both are genuinely used: `Buffer` is referenced in the
                // emitted bundle, and `process` appears in a sourcemap.
                process: "process/browser",
                Buffer: ["buffer", "Buffer"],
            }),
        ],
    });
};
