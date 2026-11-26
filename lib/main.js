const path = require("path");
const { CompositeDisposable, Disposable } = require("lumine");
const { resolveServer, latestServerVersion, installServer } = require("./server");
const { TsServerBridge } = require("./tsserver-bridge");

const Budget = require("./bridge-budget");

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

const hasGrammar = (editor) => editor.getGrammar?.() !== lumine.grammars.nullGrammar;
const eligible = (editor) => hasGrammar(editor) && Budget.editorEligible(editor);
const textForEditors = (editors) => {
  if (!editors?.size) return undefined;
  let overBudget = false;
  for (const editor of editors) {
    if (!hasGrammar(editor)) continue;
    if (Budget.editorEligible(editor)) return Budget.assertText(editor.getText());
    overBudget = true;
  }
  if (overBudget) throw Budget.failure("document exceeds its synchronization budget.");
  return null;
};

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

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "ide-vue",
      tips: [
        "{{packageName}} runs a Vue-aware TypeScript bridge for project and component intelligence.",
      ],
    };
  },

  consumeIde(service) {
    const bridges = new WeakMap();
    const liveBridges = new Map();
    const deadSessions = new WeakSet();
    const editorsByPath = new Map();
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
        textForFile: (file) => textForEditors(editorsByPath.get(pathKey(file))),
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
      latestServerVersion,
      installServer,
      async resolveServer(context) {
        return resolveServer(context, setting("serverPath"), setting("tsdk"));
      },
      getSettings: settings,
      async handleServerNotification(method, params, { session }) {
        if (method !== "tsserver/request") return;
        // vscode-jsonrpc's `auto` parameter structure wraps a single array
        // argument in another array on the wire. Vue registers this custom
        // notification by method name, so its own client unwraps it while a
        // catch-all LSP client (like ide) correctly sees the raw shape.
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
          if (error.name === "AbortError" || bridge.reportedFailure) return;
          bridge.reportedFailure = true;
          lumine.notifications.addError("Vue TypeScript bridge failed", {
            detail: error.message || String(error),
            stack: error.stack,
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
        editorsByPath.clear();
      }),
    );
    const retireIfUnowned = (key) => {
      if (!key) return;
      for (const editor of editorsByPath.get(key) || [])
        if (pathKey(editor.getPath()) === key && eligible(editor)) return;
      for (const [bridge, session] of liveBridges) {
        if (sessionIsDead(session)) continue;
        const files = new Set([...bridge.openFiles.keys(), ...bridge.requestsForFile.keys()]);
        for (const file of files) {
          if (pathKey(file) !== key) continue;
          try {
            bridge.suspendFile(file);
          } catch {
            // A failed close already retired the transport.
            break;
          }
        }
      }
    };
    subscriptions.add(
      lumine.workspace.observeTextEditors((editor) => {
        let key;
        const move = (nextKey) => {
          if (key === nextKey) return;
          const previous = key;
          const oldEditors = editorsByPath.get(previous);
          oldEditors?.delete(editor);
          if (!oldEditors?.size) editorsByPath.delete(previous);
          key = nextKey;
          if (key) {
            if (!editorsByPath.has(key)) editorsByPath.set(key, new Set());
            editorsByPath.get(key).add(editor);
          }
          retireIfUnowned(previous);
        };
        const retireIneligible = () => {
          if (!eligible(editor)) retireIfUnowned(key);
        };
        move(pathKey(editor.getPath()));
        const local = new CompositeDisposable(
          editor.onDidChangeGrammar(retireIneligible),
          editor.getBuffer().onDidChangeText(retireIneligible),
          editor.onDidChangePath(() => move(pathKey(editor.getPath()))),
          editor.onDidDestroy(() => {
            move(null);
            subscriptions.remove(local);
            local.dispose();
          }),
        );
        subscriptions.add(local);
      }),
      lumine.config.onDidChange("ide-vue.maxDocumentSize", () => {
        for (const key of editorsByPath.keys()) retireIfUnowned(key);
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
module.exports.pathKey = pathKey;
module.exports.textForEditors = textForEditors;
