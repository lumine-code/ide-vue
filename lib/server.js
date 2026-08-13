const fs = require("fs");
const path = require("path");

const bundledTsdk = () => path.dirname(require.resolve("typescript/lib/typescript.js"));

exports.resolveTsdk = (configuredPath) => configuredPath || bundledTsdk();

// Where the editor can fetch a newer server than the one this package pins.
//
// An upgrade tier, not the only way in: the dependencies below are always
// present, so uninstalling drops back to them and can never leave the user with
// nothing. `typescript` is installed beside the server because Volar loads the
// compiler named by `--tsdk`, and a managed server should be able to reach a
// managed compiler rather than reaching back into this package.
exports.managedServer = {
  source: "npm",
  displayName: "Vue Language Server",
  packages: ["@vue/language-server", "typescript"],
  module: "node_modules/@vue/language-server/bin/vue-language-server.js",
  bundled: true,
};

// The compiler the managed install carries, when there is one. The Tsdk setting
// still wins, and the copy this package ships is the floor.
exports.managedTsdk = (managed) =>
  managed?.directory ? path.join(managed.directory, "node_modules", "typescript", "lib") : null;

exports.resolveServer = async (configuredPath, tsdk, managed = null) => {
  await fs.promises.access(path.join(tsdk, "typescript.js"), fs.constants.R_OK);
  const args = ["--stdio", `--tsdk=${tsdk}`];
  if (configuredPath) {
    await fs.promises.access(configuredPath, fs.constants.X_OK);
    return { command: configuredPath, args };
  }

  const serverModule =
    managed?.modulePath || require.resolve("@vue/language-server/bin/vue-language-server.js");
  return {
    command: process.execPath,
    args: [serverModule, ...args],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    version: managed?.version,
  };
};

exports.bundledTsdk = bundledTsdk;
