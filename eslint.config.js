const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

const runtimeModules = ["lumine"];

module.exports = [
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    settings: { n: { version: ">=24.0.0" } },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.browser, ...globals.node, lumine: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
    },
  },
  {
    files: ["eslint.config.js"],
    rules: {
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  {
    files: ["spec/**", "**/*-spec.js"],
    languageOptions: { globals: { ...globals.jasmine } },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  prettier,
];
