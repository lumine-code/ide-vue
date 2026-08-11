const fs = require("fs");
const path = require("path");

const bundledTsdk = () => path.dirname(require.resolve("typescript/lib/typescript.js"));

exports.resolveTsdk = (configuredPath) => configuredPath || bundledTsdk();

exports.resolveServer = async (configuredPath, tsdk) => {
  await fs.promises.access(path.join(tsdk, "typescript.js"), fs.constants.R_OK);
  const args = ["--stdio", `--tsdk=${tsdk}`];
  if (configuredPath) {
    await fs.promises.access(configuredPath, fs.constants.X_OK);
    return { command: configuredPath, args };
  }

  const serverModule = require.resolve("@vue/language-server/bin/vue-language-server.js");
  return {
    command: process.execPath,
    args: [serverModule, ...args],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
};

exports.bundledTsdk = bundledTsdk;
