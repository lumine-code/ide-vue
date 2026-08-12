const childProcess = require("child_process");
const path = require("path");
const { pathToFileURL } = require("url");
const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} = require("vscode-jsonrpc/node");

const TIMEOUT_MS = 20000;

const withTimeout = (promise, label, timeout = TIMEOUT_MS) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
};

const symbolKinds = { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) };
const capabilities = () => ({
  workspace: {
    applyEdit: true,
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: true },
    didChangeWatchedFiles: {
      dynamicRegistration: true,
      relativePatternSupport: true,
    },
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      failureHandling: "textOnlyTransactional",
    },
    diagnostics: { refreshSupport: true },
    codeLens: { refreshSupport: true },
    inlayHint: { refreshSupport: true },
    semanticTokens: { refreshSupport: true },
    symbol: { dynamicRegistration: true, symbolKind: symbolKinds },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: true },
    publishDiagnostics: {
      relatedInformation: true,
      tagSupport: { valueSet: [1, 2] },
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
    completion: {
      dynamicRegistration: true,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        resolveSupport: {
          properties: ["documentation", "detail", "additionalTextEdits", "command"],
        },
      },
    },
    hover: {
      dynamicRegistration: true,
      contentFormat: ["markdown", "plaintext"],
    },
    signatureHelp: {
      dynamicRegistration: true,
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
      },
    },
    declaration: { dynamicRegistration: true, linkSupport: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    typeDefinition: { dynamicRegistration: true, linkSupport: true },
    implementation: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
    documentHighlight: { dynamicRegistration: true },
    documentSymbol: {
      dynamicRegistration: true,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: symbolKinds,
    },
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true, rangesSupport: true },
    rename: {
      dynamicRegistration: true,
      prepareSupport: true,
      honorsChangeAnnotations: true,
    },
    codeAction: {
      dynamicRegistration: true,
      dataSupport: true,
      resolveSupport: { properties: ["edit", "command"] },
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "",
            "quickfix",
            "refactor",
            "refactor.extract",
            "refactor.inline",
            "refactor.rewrite",
            "source",
          ],
        },
      },
    },
    codeLens: { dynamicRegistration: true },
    inlayHint: {
      dynamicRegistration: true,
      resolveSupport: { properties: ["tooltip", "textEdits", "label.tooltip"] },
    },
    semanticTokens: {
      dynamicRegistration: true,
      requests: { range: true, full: { delta: true } },
      tokenTypes: [],
      tokenModifiers: [],
      formats: ["relative"],
      overlappingTokenSupport: false,
      multilineTokenSupport: true,
    },
    callHierarchy: { dynamicRegistration: true },
    typeHierarchy: { dynamicRegistration: true },
    foldingRange: {
      dynamicRegistration: true,
      lineFoldingOnly: false,
      rangeLimit: 5000,
    },
    linkedEditingRange: { dynamicRegistration: true },
    documentLink: { dynamicRegistration: true, tooltipSupport: true },
    colorProvider: { dynamicRegistration: true },
  },
  window: { workDoneProgress: true, showDocument: { support: true } },
  general: { positionEncodings: ["utf-16"] },
});

class LiveLspClient {
  constructor(adapter, rootPath) {
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.notifications = [];
    this.registrations = [];
    this.appliedEdits = [];
    this.configurationRequests = [];
    this.stderr = "";
  }

  async start() {
    const launch = await this.adapter.resolveServer({ rootPath: this.rootPath });
    this.child = childProcess.spawn(launch.command, launch.args || [], {
      cwd: launch.cwd || this.rootPath,
      env: { ...process.env, ...(launch.env || {}) },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
    this.child.on("exit", (code, signal) => {
      this.exit = { code, signal };
      this.stderr += `\n[server exited: code=${code}, signal=${signal}]`;
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
      {
        error: (message) => (this.stderr += `${message}\n`),
        warn: (message) => (this.stderr += `${message}\n`),
        info() {},
        log() {},
      },
    );
    this.session = {
      adapter: this.adapter,
      rootPath: this.rootPath,
      state: "running",
      notify: (method, params) => this.connection.sendNotification(method, params),
    };
    this.connection.onNotification((method, params) => {
      this.notifications.push({ method, params });
      Promise.resolve(
        this.adapter.handleServerNotification?.(method, params, {
          session: this.session,
        }),
      ).catch((error) => (this.stderr += `${error.stack || error}\n`));
    });
    this.connection.onRequest("workspace/configuration", ({ items }) => {
      this.configurationRequests.push(...items);
      return Promise.all(
        items.map(({ section, scopeUri }) =>
          this.adapter.getWorkspaceConfiguration?.(section, scopeUri),
        ),
      );
    });
    this.connection.onRequest("client/registerCapability", ({ registrations }) => {
      this.registrations.push(...registrations);
      return null;
    });
    this.connection.onRequest("client/unregisterCapability", ({ unregistrations = [] }) => {
      const ids = new Set(unregistrations.map(({ id }) => id));
      this.registrations = this.registrations.filter(({ id }) => !ids.has(id));
      return null;
    });
    this.connection.onRequest("workspace/workspaceFolders", () => this.workspaceFolders);
    this.connection.onRequest("workspace/applyEdit", ({ label, edit }) => {
      this.appliedEdits.push({ label, edit });
      return { applied: true };
    });
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("window/showDocument", () => ({ success: true }));
    for (const method of [
      "workspace/codeLens/refresh",
      "workspace/semanticTokens/refresh",
      "workspace/inlayHint/refresh",
      "workspace/diagnostic/refresh",
    ]) {
      this.connection.onRequest(method, () => null);
    }
    this.connection.listen();

    const rootUri = pathToFileURL(this.rootPath).href;
    this.workspaceFolders = [{ uri: rootUri, name: path.basename(this.rootPath) }];
    this.initializeResult = await this.request("initialize", {
      processId: process.pid,
      clientInfo: {
        name: "Lumine adapter integration specs",
        version: "1.0.0",
      },
      rootUri,
      workspaceFolders: this.workspaceFolders,
      capabilities: capabilities(),
      initializationOptions: await this.adapter.getInitializationOptions?.({
        rootPath: this.rootPath,
        rootUri,
      }),
    });
    this.connection.sendNotification("initialized", {});
    const settings =
      (await this.adapter.getSettings?.()) ??
      (await this.adapter.getWorkspaceConfiguration?.(undefined)) ??
      {};
    this.connection.sendNotification("workspace/didChangeConfiguration", {
      settings,
    });
    return this.initializeResult;
  }

  request(method, params, timeout) {
    return withTimeout(
      this.connection.sendRequest(method, params),
      `${this.adapter.displayName} ${method}; stderr: ${this.stderr}`,
      timeout,
    );
  }

  notify(method, params) {
    return this.connection.sendNotification(method, params);
  }

  open(uri, languageId, text, version = 1) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  change(uri, text, version = 2) {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  closeDocument(uri) {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  messages(method) {
    return this.notifications.filter((message) => message.method === method);
  }

  async waitFor(check, label, timeout = TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${label} timed out; stderr: ${this.stderr}`);
  }

  async stop() {
    if (!this.connection) return;
    try {
      await withTimeout(this.connection.sendRequest("shutdown"), "shutdown", 3000);
      this.connection.sendNotification("exit");
    } catch {
      this.child?.kill();
    }
    await Promise.race([
      new Promise((resolve) => this.child.once("exit", resolve)),
      new Promise((resolve) =>
        setTimeout(() => {
          this.child.kill();
          resolve();
        }, 1000),
      ),
    ]);
    this.connection.dispose();
  }
}

exports.LiveLspClient = LiveLspClient;

// Edit a fixture and refuse to carry on when the search text is not there.
// String#replace returns the subject untouched when it matches nothing, so a
// fixture that has drifted — or that git rewrote on the way to the worktree —
// leaves the document unchanged and the spec asserts against a document it
// never edited. Fail at the edit, where the reason is still legible.
exports.replaceOnce = (source, search, replacement = "") => {
  if (!source.includes(search)) {
    throw new Error(`Fixture does not contain ${JSON.stringify(search)}`);
  }
  return source.replace(search, replacement);
};

exports.fileUri = (filePath) => pathToFileURL(filePath).href;
exports.position = (line, character) => ({ line, character });
exports.positionParams = (uri, line, character) => ({
  textDocument: { uri },
  position: { line, character },
});
