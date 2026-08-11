const path = require("path");
const { CompositeDisposable, Disposable } = require("lumine");
const { resolveServer, resolveTsdk } = require("./server");
const { TsServerBridge } = require("./tsserver-bridge");

const setting = (key) => lumine.config.get(`ide-vue.${key}`);

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
    const liveBridges = new Set();
    const stopBridge = (session) => {
      const bridge = bridges.get(session);
      if (!bridge) return;
      bridge.stop();
      bridges.delete(session);
      liveBridges.delete(bridge);
    };
    const bridgeFor = (session) => {
      let bridge = bridges.get(session);
      if (bridge) return bridge;
      bridge = new TsServerBridge({
        rootPath: session.rootPath,
        tsdk: resolveTsdk(setting("tsdk")),
        textForFile(file) {
          const normalized = path.normalize(file);
          return lumine.workspace
            .getTextEditors()
            .find((editor) => path.normalize(editor.getPath() || "") === normalized)
            ?.getText();
        },
      });
      bridges.set(session, bridge);
      liveBridges.add(bridge);
      return bridge;
    };

    const adapter = {
      id: "ide-vue",
      displayName: "Vue Language Server",
      grammarScopes: ["text.html.vue"],
      languageId: "vue",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-vue"],
      async resolveServer(context) {
        const tsdk = resolveTsdk(setting("tsdk"));
        const launch = await resolveServer(setting("serverPath"), tsdk);
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
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
        try {
          const result = await bridge.request(command, args);
          session.notify("tsserver/response", [id, result]);
        } catch (error) {
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
        for (const bridge of liveBridges) bridge.stop();
        liveBridges.clear();
      }),
    );
    const sessionSubscription = service.onDidChangeSession?.(({ session, state }) => {
      if (session.adapter === adapter && ["failed", "stopped"].includes(state)) stopBridge(session);
    });
    if (sessionSubscription) subscriptions.add(sessionSubscription);

    const restart = () => {
      for (const session of service.getSessions()) {
        if (session.adapter !== adapter || ["stopping", "stopped"].includes(session.state))
          continue;
        stopBridge(session);
        service.restart(session).catch((error) => {
          lumine.notifications.addError("Unable to restart Vue Language Server", {
            detail: error.message,
            dismissable: true,
          });
        });
      }
    };
    subscriptions.add(
      lumine.config.onDidChange("ide-vue.serverPath", restart),
      lumine.config.onDidChange("ide-vue.tsdk", restart),
    );
    return subscriptions;
  },
};

module.exports.settings = settings;
module.exports.valueAtSection = valueAtSection;
