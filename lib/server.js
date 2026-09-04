const fs = require("fs");
const path = require("path");

const bundledTsdk = () => path.dirname(require.resolve("typescript/lib/typescript.js"));
const bundledPluginProbeLocation = () =>
  path.resolve(path.dirname(require.resolve("@vue/typescript-plugin/package.json")), "..", "..");

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
  packages: ["@vue/language-server", { name: "typescript", version: "^6.0.3" }],
  module: "node_modules/@vue/language-server/bin/vue-language-server.js",
  bundled: true,
};

// The compiler the managed install carries, when there is one. The Tsdk setting
// still wins, and the copy this package ships is the floor.
exports.managedTsdk = (managed) =>
  managed?.directory ? path.join(managed.directory, "node_modules", "typescript", "lib") : null;

// npm installs @vue/language-server's matching @vue/typescript-plugin beside
// the managed server. The companion tsserver must probe that copy rather than
// the older plugin bundled with this adapter.
exports.pluginProbeLocation = (configuredPath, managed) =>
  !configuredPath && managed?.directory
    ? path.join(managed.directory, "node_modules")
    : bundledPluginProbeLocation();

exports.resolveServer = async (configuredPath, tsdk, managed = null) => {
  await fs.promises.access(path.join(tsdk, "typescript.js"), fs.constants.R_OK);
  const args = ["--stdio", `--tsdk=${tsdk}`];
  const pluginProbeLocation = exports.pluginProbeLocation(configuredPath, managed);
  if (configuredPath) {
    await fs.promises.access(configuredPath, fs.constants.X_OK);
    return { command: configuredPath, args, pluginProbeLocation };
  }

  const serverModule =
    managed?.modulePath || require.resolve("@vue/language-server/bin/vue-language-server.js");
  return {
    command: process.execPath,
    args: [serverModule, ...args],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    version: managed?.version,
    pluginProbeLocation,
  };
};

exports.bundledTsdk = bundledTsdk;
exports.bundledPluginProbeLocation = bundledPluginProbeLocation;
