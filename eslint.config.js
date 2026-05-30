const nPlugin = require("eslint-plugin-n");
const prettierConfig = require("eslint-config-prettier");

// eslint-plugin-n ships as an ES module; unwrap the default export when CJS-required
const n = nPlugin.default || nPlugin;

module.exports = [
  { ignores: ["node_modules/**", "uploads/**"] },

  n.configs["flat/recommended"],

  {
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      // devDeps (e.g. ESLint plugins) required in config files are fine
      "n/no-unpublished-require": "off",
      "n/no-missing-require": "off",
      "n/no-process-exit": "off",
      // fetch is stable in Node 18+ (our server target); skip the version check
      "n/no-unsupported-features/node-builtins": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-unsupported-features/es-builtins": "off",
    },
  },

  // Must be last — disables ESLint rules that conflict with Prettier formatting
  prettierConfig,
];
