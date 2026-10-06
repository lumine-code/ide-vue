const path = require("path");

const bundledTsdk = () => path.dirname(require.resolve("typescript/lib/typescript.js"));
const bundledPluginProbeLocation = () =>
  path.resolve(path.dirname(require.resolve("@vue/typescript-plugin/package.json")), "..", "..");

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
    (managed ? path.join(managed.directory, "node_modules", "typescript", "lib") : bundledTsdk());
  await context.resolver.validateFile(tsdk, { kind: "directory", label: "TypeScript SDK" });
  for (const file of ["typescript.js", "tsserver.js"])
    await context.resolver.validateFile(path.join(tsdk, file), {
      kind: "file",
      label: "TypeScript SDK",
    });
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
