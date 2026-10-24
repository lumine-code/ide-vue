const path = require("path");
const fs = require("fs");
const { dependencies } = require("../package.json");

const SDK_PACKAGE = "typescript-native-bridge";
const bundledTsdk = () => path.dirname(require.resolve(`${SDK_PACKAGE}/lib/typescript.js`));
const bundledPluginProbeLocation = () =>
  path.resolve(path.dirname(require.resolve("@vue/typescript-plugin/package.json")), "..", "..");

exports.latestServerVersion = (api, options = {}) =>
  api.npmPackageLatestVersion("@vue/language-server", options);

exports.installServer = async ({ storagePath, version, api, signal = api.signal }) => {
  signal?.throwIfAborted();
  const requested = version || (await exports.latestServerVersion(api, { signal }));
  api.setServerInstallationStatus("installing");
  for (const [name, pinned] of [
    [SDK_PACKAGE, dependencies[SDK_PACKAGE]],
    ["@vue/typescript-plugin", requested],
    ["@vue/language-server", requested],
  ]) {
    signal?.throwIfAborted();
    await api.npmInstallPackage(name, pinned, storagePath, { signal });
  }
  signal?.throwIfAborted();
  const installed = api.npmPackageInstalledVersion("@vue/language-server", storagePath);
  if (!installed) throw new Error("The Vue installation contains no language-server version.");
  return {
    module: "node_modules/@vue/language-server/bin/vue-language-server.js",
    version: installed,
  };
};

exports.resolveServer = async (context, configuredPath, configuredTsdk = "") => {
  const selection = await context.resolver.select({
    configuredPath,
    configuredKind: "auto",
    managed: () => {
      const install = context.getManagedServer();
      return install ? { path: install.modulePath, version: install.version } : null;
    },
    bundledPath: () => require.resolve("@vue/language-server/bin/vue-language-server.js"),
    kind: "node",
    allowShellWrapper: true,
  });
  if (!selection) return null;

  // Resolve companions after selecting the server generation. A configured
  // server must never inherit the compiler or plugin of a managed install.
  const managed = selection.source === "managed" ? context.getManagedServer() : null;
  if (managed && !managed.directory)
    throw new Error("The managed Vue server has no installation directory.");
  const tsdk =
    configuredTsdk ||
    (managed ? path.join(managed.directory, "node_modules", SDK_PACKAGE, "lib") : bundledTsdk());
  await context.resolver.validateFile(tsdk, { kind: "directory", label: "TypeScript SDK" });
  for (const file of ["typescript.js", "tsserver.js"])
    await context.resolver.validateFile(path.join(tsdk, file), {
      kind: "file",
      label: "TypeScript SDK",
    });
  const sdk = JSON.parse(await fs.promises.readFile(path.join(tsdk, "..", "package.json"), "utf8"));
  if (sdk.name !== SDK_PACKAGE || !/\.tsgo\.7\./.test(sdk.version))
    throw new Error("Choose a TypeScript native bridge SDK backed by TypeScript 7.");
  const pluginProbeLocation = managed
    ? path.join(managed.directory, "node_modules")
    : bundledPluginProbeLocation();
  await context.resolver.validateFile(
    path.join(pluginProbeLocation, "@vue", "typescript-plugin", "package.json"),
    { kind: "file", label: "Vue TypeScript plugin" },
  );
  return context.resolver.launch(selection, {
    args: ["--stdio", `--tsdk=${tsdk}`],
    cwd: context.rootPath,
    transport: "stdio",
    tsdk,
    pluginProbeLocation,
  });
};

exports.bundledTsdk = bundledTsdk;
exports.bundledPluginProbeLocation = bundledPluginProbeLocation;
