module.exports = {
    env: {
        browser: true,
        es2021: true,
        node: true,
    },
    globals: {
        __PATH_PREFIX__: true,
    },
    extends: ["plugin:react/recommended"],
    parserOptions: {
        ecmaFeatures: {
            jsx: true,
        },
        ecmaVersion: 2021,
        sourceType: "module",
    },
    settings: {
        react: {
            version: "detect",
        },
    },
    rules: {
        "react/no-unescaped-entities": "off",
        "react/prop-types": "off",
    },
};
