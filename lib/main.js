const path = require("path");
const { CompositeDisposable, Disposable } = require("lumine");
const { resolveServer, resolveTsdk, managedServer, managedTsdk } = require("./server");
const { TsServerBridge } = require("./tsserver-bridge");

const VUE_SCOPE = ["text.html.vue"];
// The feature switches are grammar-scoped. Reading them without that scope can
// leave the client router enabled while the settings sent to Volar disable the
// same feature globally (base false plus a Vue-scoped true override).
const setting = (key) => lumine.config.get(`ide-vue.${key}`, { scope: VUE_SCOPE });

const pathKey = (filePath, platform = process.platform) => {
  if (!filePath) return null;
  const normalized = (platform === "win32" ? path.win32 : path.posix).normalize(filePath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};

const textForOpenFile = (file, platform = process.platform) =>
  lumine.workspace
    .getTextEditors()
    .find((editor) => pathKey(editor.getPath(), platform) === pathKey(file, platform))
    ?.getText();

const typescriptSettings = () => ({
  validate: { enable: setting("features.diagnostics") },
  suggest: {
    enabled: setting("features.autocomplete"),
    autoImports: setting("typescript.suggest.autoImports"),
    completeFunctionCalls: setting("typescript.suggest.completeFunctionCalls"),
    includeCompletionsWithSnippetText: true,
    includeCompletionsForImportStatements: true,
  },
  preferences: {
    quoteStyle: setting("typescript.preferences.quoteStyle"),
    importModuleSpecifier: setting("typescript.preferences.importModuleSpecifier"),
  },
  inlayHints: {
    parameterNames: {
      enabled: setting("typescript.inlayHints.parameterNames"),
      suppressWhenArgumentMatchesName: true,
    },
    parameterTypes: {
      enabled: setting("typescript.inlayHints.parameterTypes"),
    },
    variableTypes: {
      enabled: setting("typescript.inlayHints.variableTypes"),
      suppressWhenTypeMatchesName: true,
    },
    propertyDeclarationTypes: {
      enabled: setting("typescript.inlayHints.propertyDeclarationTypes"),
    },
    functionLikeReturnTypes: {
      enabled: setting("typescript.inlayHints.functionLikeReturnTypes"),
    },
    enumMemberValues: {
      enabled: setting("typescript.inlayHints.enumMemberValues"),
    },
  },
  format: { enable: setting("features.format") },
});

const vueSettings = () => ({
  suggest: {
    componentNameCasing: setting("vue.suggest.componentNameCasing"),
    propNameCasing: setting("vue.suggest.propNameCasing"),
    defineAssignment: setting("vue.suggest.defineAssignment"),
  },
  hover: { rich: setting("vue.hover.rich") },
  format: {
    script: {
      enabled: setting("vue.format.script.enabled"),
      initialIndent: setting("vue.format.script.initialIndent"),
    },
    style: {
      enabled: setting("vue.format.style.enabled"),
      initialIndent: setting("vue.format.style.initialIndent"),
    },
    template: {
      enabled: setting("vue.format.template.enabled"),
      initialIndent: setting("vue.format.template.initialIndent"),
    },
    wrapAttributes: setting("vue.format.wrapAttributes"),
  },
  inlayHints: {
    missingProps: setting("vue.inlayHints.missingProps"),
    destructuredProps: setting("vue.inlayHints.destructuredProps"),
    vBindShorthand: setting("vue.inlayHints.vBindShorthand"),
    optionsWrapper: setting("vue.inlayHints.optionsWrapper"),
    inlineHandlerLeading: setting("vue.inlayHints.inlineHandlerLeading"),
  },
  autoInsert: {
    bracketSpacing: setting("vue.autoInsert.bracketSpacing"),
    dotValue: setting("vue.autoInsert.dotValue"),
  },
});

const embeddedLanguageSettings = (language) => ({
  validate: setting("features.diagnostics"),
  format: { enable: setting("features.format") },
  ...(language === "html"
    ? {
        completion: {
          autoClosingTags: setting("html.autoClosingTags"),
          autoCreateQuotes: setting("html.autoCreateQuotes"),
        },
        hover: { documentation: setting("features.hover") },
      }
    : {}),
});

const settings = () => {
  const typescript = typescriptSettings();
  return {
    vue: vueSettings(),
    typescript,
    javascript: typescript,
    html: embeddedLanguageSettings("html"),
    css: embeddedLanguageSettings("css"),
    scss: embeddedLanguageSettings("scss"),
    less: embeddedLanguageSettings("less"),
  };
};

const valueAtSection = (value, section) => {
  if (!section) return value;
  return section
    .split(".")
    .reduce(
      (current, segment) =>
        current && Object.hasOwn(current, segment) ? current[segment] : undefined,
      value,
    );
};

module.exports = {
  consumeIdeClient(service) {
    const bridges = new WeakMap();
    const liveBridges = new Map();
    const deadSessions = new WeakSet();
    const sessionIsDead = (session) =>
      deadSessions.has(session) || ["stopping", "stopped", "failed"].includes(session.state);
    const stopBridge = (session) => {
      deadSessions.add(session);
      const bridge = bridges.get(session);
      if (!bridge) return;
      bridges.delete(session);
      void bridge.stop().then(
        () => liveBridges.delete(bridge),
        (error) => {
          lumine.notifications.addError("Unable to stop Vue TypeScript bridge", {
            detail: error.message,
            dismissable: true,
          });
        },
      );
    };
    const bridgeFor = (session) => {
      if (sessionIsDead(session)) return null;
      let bridge = bridges.get(session);
      if (bridge) return bridge;
      bridge = new TsServerBridge({
        rootPath: session.rootPath,
        // The bridge belongs to this server generation. A later invalid Tsdk
        // setting must not change the compiler under a still-running session.
        tsdk: session.launch.tsdk,
        pluginProbeLocation: session.launch.pluginProbeLocation,
        textForFile: textForOpenFile,
      });
      bridges.set(session, bridge);
      liveBridges.set(bridge, session);
      return bridge;
    };

    const adapter = {
      id: "ide-vue",
      displayName: "Vue Language Server",
      grammarScopes: ["text.html.vue"],
      languageId: "vue",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-vue"],
      restartKeyPaths: ["ide-vue.serverPath", "ide-vue.tsdk"],
      managedServer,
      async resolveServer(context) {
        // The setting wins, then the compiler the managed install carries, then
        // the one this package ships — the same order the server itself follows.
        const tsdk =
          setting("tsdk") || managedTsdk(context.managedServer) || resolveTsdk(setting("tsdk"));
        const launch = await resolveServer(setting("serverPath"), tsdk, context.managedServer);
        return { ...launch, cwd: context.rootPath, transport: "stdio", tsdk };
      },
      getSettings: settings,
      getWorkspaceConfiguration(section) {
        return valueAtSection(settings(), section);
      },
      async handleServerNotification(method, params, { session }) {
        if (method !== "tsserver/request") return;
        // vscode-jsonrpc's `auto` parameter structure wraps a single array
        // argument in another array on the wire. Vue registers this custom
        // notification by method name, so its own client unwraps it while a
        // catch-all LSP client (like ide-client) correctly sees the raw shape.
        const payload = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const [id, command, args] = payload;
        const bridge = bridgeFor(session);
        if (!bridge) return;
        try {
          const result = await bridge.request(command, args);
          if (sessionIsDead(session) || bridges.get(session) !== bridge) return;
          session.notify("tsserver/response", [id, result]);
        } catch (error) {
          if (sessionIsDead(session) || bridges.get(session) !== bridge) return;
          session.notify("tsserver/response", [id, null]);
          if (bridge.reportedFailure) return;
          bridge.reportedFailure = true;
          lumine.notifications.addError("Vue TypeScript bridge failed", {
            detail: error.stack || error.message,
            dismissable: true,
          });
        }
      },
    };

    const subscriptions = new CompositeDisposable(
      service.registerAdapter(adapter),
      new Disposable(() => {
        for (const [bridge, session] of liveBridges) {
          deadSessions.add(session);
          bridge.kill();
          bridges.delete(session);
        }
        liveBridges.clear();
      }),
    );
    const sessionSubscription = service.onDidChangeSession?.(({ session, state }) => {
      if (session.adapter === adapter && ["stopping", "failed", "stopped"].includes(state))
        stopBridge(session);
    });
    if (sessionSubscription) subscriptions.add(sessionSubscription);
    return subscriptions;
  },
};

module.exports.settings = settings;
module.exports.valueAtSection = valueAtSection;
module.exports.pathKey = pathKey;
module.exports.textForOpenFile = textForOpenFile;
