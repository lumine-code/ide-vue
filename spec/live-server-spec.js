const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const main = require("../lib/main");
const { LiveLspClient, fileUri, position, positionParams } = require("./helpers/live-lsp-client");

const registerAdapter = () => {
  let adapter;
  const disposable = main.consumeIdeClient({
    registerAdapter(registered) {
      adapter = registered;
      return { dispose() {} };
    },
    getSessions: () => [],
    restart: async () => {},
  });
  return { adapter, disposable };
};

const itemsOf = (completion) => completion?.items || completion || [];
const pathOf = (value) => path.normalize(fileURLToPath(value)).toLowerCase();

describe("ide-vue bundled server", () => {
  let adapter, client, disposable, rootPath, source, uri;
  let originalTimeout;

  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;
  });

  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("ide-vue");
    ({ adapter, disposable } = registerAdapter());
    rootPath = path.join(__dirname, "fixtures", "drive");
    const filePath = path.join(rootPath, "App.vue");
    source = fs.readFileSync(filePath, "utf8");
    uri = fileUri(filePath);
    client = new LiveLspClient(adapter, rootPath);
  });

  afterEach(async () => {
    await client.stop();
    disposable.dispose();
    await lumine.packages.deactivatePackage("ide-vue");
  });

  it("advertises the complete Vue protocol surface without unsupported claims", async () => {
    const { capabilities, serverInfo } = await client.start();
    expect(serverInfo).toEqual({ name: "@vue/language-server", version: "3.3.9" });
    expect(capabilities.textDocumentSync).toBe(2);
    expect(capabilities.diagnosticProvider).toEqual({
      interFileDependencies: false,
      workspaceDiagnostics: false,
    });
    expect(capabilities.completionProvider.resolveProvider).toBe(true);
    expect(capabilities.completionProvider.triggerCharacters).toEqual(
      jasmine.arrayContaining(["<", ":", "@", ".", "/"]),
    );
    expect(capabilities.hoverProvider).toBe(true);
    expect(capabilities.definitionProvider).toBe(true);
    expect(capabilities.referencesProvider).toBe(true);
    expect(capabilities.documentHighlightProvider).toBe(true);
    expect(capabilities.documentSymbolProvider).toBe(true);
    expect(capabilities.documentFormattingProvider).toBe(true);
    expect(capabilities.documentRangeFormattingProvider).toBe(true);
    expect(capabilities.documentOnTypeFormattingProvider).toEqual({
      firstTriggerCharacter: ";",
      moreTriggerCharacter: ["}", "\n"],
    });
    expect(capabilities.renameProvider).toEqual({ prepareProvider: true });
    expect(capabilities.codeActionProvider).toEqual({
      codeActionKinds: ["refactor"],
      resolveProvider: true,
    });
    expect(capabilities.inlayHintProvider).toEqual({});
    expect(capabilities.semanticTokensProvider.full).toBe(true);
    expect(capabilities.semanticTokensProvider.range).toBe(true);
    expect(capabilities.semanticTokensProvider.legend.tokenTypes).toContain("component");
    expect(capabilities.selectionRangeProvider).toBe(true);
    expect(capabilities.foldingRangeProvider).toBe(true);
    expect(capabilities.linkedEditingRangeProvider).toBe(true);
    expect(capabilities.documentLinkProvider).toEqual({});
    expect(capabilities.colorProvider).toBe(true);
    expect(capabilities.signatureHelpProvider).toBeUndefined();
    expect(capabilities.callHierarchyProvider).toBeUndefined();
    expect(capabilities.typeHierarchyProvider).toBeUndefined();
    expect(capabilities.codeLensProvider).toBeUndefined();
  });

  it("uses the custom tsserver bridge for project and component completion", async () => {
    await client.start();
    client.open(uri, "vue", source);

    const tags = itemsOf(
      await client.request("textDocument/completion", {
        textDocument: { uri },
        position: position(15, 5),
        context: { triggerKind: 1 },
      }),
    );
    expect(tags.map(({ label }) => label)).toEqual(
      jasmine.arrayContaining(["ChildCard", "Transition", "component"]),
    );
    const component = tags.find(({ label }) => label === "ChildCard");
    const resolved = await client.request("completionItem/resolve", component);
    expect(resolved.label).toBe("ChildCard");
    expect(resolved.data).toBeUndefined();

    const props = itemsOf(
      await client.request("textDocument/completion", {
        textDocument: { uri },
        position: position(15, 15),
        context: { triggerKind: 1 },
      }),
    );
    expect(props.map(({ label }) => label)).toContain(":count");
    await client.waitFor(
      () =>
        client
          .messages("tsserver/request")
          .some(({ params }) => JSON.stringify(params).includes("_vue:getComponentNames")),
      "component-name bridge request",
    );
    const customTraffic = JSON.stringify(client.messages("tsserver/request"));
    expect(customTraffic).toContain("_vue:projectInfo");
    expect(customTraffic).toContain("_vue:getComponentNames");
    expect(client.stderr).toBe("");
  });

  it("serves pull diagnostics, hover, structure, hints and semantic tokens", async () => {
    lumine.config.set("ide-vue.vue.inlayHints.missingProps", true);
    await client.start();
    client.open(uri, "vue", source);

    const diagnostic = await client.request("textDocument/diagnostic", {
      textDocument: { uri },
    });
    expect(diagnostic.kind).toBe("full");
    expect(diagnostic.items.length).toBe(1);
    expect(diagnostic.items[0].code).toBe("css-propertyvalueexpected");
    expect(diagnostic.items[0].source).toBe("css");
    expect(diagnostic.items[0].severity).toBe(1);
    expect(diagnostic.items[0].range.start).toEqual(position(23, 17));

    const hover = await client.request("textDocument/hover", positionParams(uri, 22, 27));
    expect(JSON.stringify(hover.contents)).toContain("color");

    const symbols = await client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    expect(symbols.map(({ name }) => name)).toEqual(["template", "script setup", "style scoped"]);
    expect(symbols[0].children.map(({ name }) => name)).toContain("main");
    expect(symbols[1].children.map(({ name }) => name)).toEqual(
      jasmine.arrayContaining(["count", "doubled", "increment", "label"]),
    );
    expect(symbols[2].children.map(({ name }) => name)).toEqual([".active", ".broken"]);

    const hints = await client.request("textDocument/inlayHint", {
      textDocument: { uri },
      range: { start: position(0, 0), end: position(24, 0) },
    });
    expect(hints.some(({ label }) => JSON.stringify(label).includes("count"))).toBe(true);

    const semantic = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    expect(semantic.data.length).toBeGreaterThan(50);
    expect(semantic.data.length % 5).toBe(0);
    const semanticRange = await client.request("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start: position(13, 0), end: position(19, 0) },
    });
    expect(semanticRange.data.length).toBeGreaterThan(0);
  });

  it("navigates and edits CSS bindings embedded in the SFC", async () => {
    await client.start();
    client.open(uri, "vue", source);

    const definition = await client.request("textDocument/definition", positionParams(uri, 22, 37));
    expect(definition.length).toBeGreaterThan(0);
    // CSS returns the richer LocationLink spelling while several other Vue
    // providers use plain Location values; ide-client accepts both forms.
    expect(pathOf(definition[0].targetUri || definition[0].uri)).toBe(
      path.join(rootPath, "App.vue").toLowerCase(),
    );
    expect((definition[0].targetSelectionRange || definition[0].range).start).toEqual(
      position(22, 8),
    );

    const references = await client.request("textDocument/references", {
      ...positionParams(uri, 22, 10),
      context: { includeDeclaration: true },
    });
    expect(references.length).toBeGreaterThanOrEqual(2);
    expect(references.every(({ uri: value }) => pathOf(value) === pathOf(uri))).toBe(true);

    const highlights = await client.request(
      "textDocument/documentHighlight",
      positionParams(uri, 4, 7),
    );
    expect(highlights.length).toBeGreaterThanOrEqual(3);
    expect(highlights.map(({ kind }) => kind)).toContain(3);

    const prepared = await client.request(
      "textDocument/prepareRename",
      positionParams(uri, 22, 10),
    );
    expect(prepared).not.toBeNull();
    const rename = await client.request("textDocument/rename", {
      ...positionParams(uri, 22, 10),
      newName: "--selected",
    });
    const renameEdits = rename.documentChanges
      ? rename.documentChanges.flatMap(({ edits = [] }) => edits)
      : Object.values(rename.changes || {}).flat();
    expect(renameEdits.length).toBeGreaterThanOrEqual(2);
    expect(renameEdits.every(({ newText }) => newText.includes("selected"))).toBe(true);

    const links = await client.request("textDocument/documentLink", {
      textDocument: { uri },
    });
    expect(links.some(({ target }) => target.includes("#L23"))).toBe(true);
  });

  it("formats, refactors and serves the remaining structural features", async () => {
    await client.start();
    client.open(uri, "vue", source);

    const fixed = source.replace(".broken { color: ; }\n", "");
    client.change(uri, fixed);
    const formatting = await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(formatting.length).toBeGreaterThan(0);
    expect(formatting.some(({ newText }) => newText.includes("#ff0000"))).toBe(true);
    const rangeFormatting = await client.request("textDocument/rangeFormatting", {
      textDocument: { uri },
      range: { start: position(21, 0), end: position(23, 0) },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(rangeFormatting.length).toBeGreaterThan(0);

    const action = (
      await client.request("textDocument/codeAction", {
        textDocument: { uri },
        range: { start: position(15, 4), end: position(15, 61) },
        context: { diagnostics: [], only: ["refactor"] },
      })
    ).find(({ title }) => title.includes("Extract"));
    expect(action.kind).toBe("refactor.move.newFile.dumb");
    const resolved = await client.request("codeAction/resolve", action);
    expect(resolved.edit.documentChanges.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(resolved.edit)).toContain("NewComponent.vue");

    const selections = await client.request("textDocument/selectionRange", {
      textDocument: { uri },
      positions: [position(15, 7)],
    });
    expect(selections[0].parent.parent).toBeDefined();
    const folds = await client.request("textDocument/foldingRange", {
      textDocument: { uri },
    });
    expect(folds.length).toBeGreaterThanOrEqual(6);
    const linked = await client.request("textDocument/linkedEditingRange", {
      ...positionParams(uri, 14, 4),
    });
    expect(linked.ranges.length).toBe(2);
    const colors = await client.request("textDocument/documentColor", {
      textDocument: { uri },
    });
    expect(colors.length).toBe(1);
    expect(colors[0].color).toEqual({ red: 1, green: 0, blue: 0, alpha: 1 });
  });

  it("revalidates full-sync changes and applies live configuration", async () => {
    await client.start();
    client.open(uri, "vue", source);
    expect(
      (await client.request("textDocument/diagnostic", { textDocument: { uri } })).items.length,
    ).toBe(1);

    const fixed = source.replace(".broken { color: ; }\n", "");
    client.change(uri, fixed, 2);
    expect(
      (await client.request("textDocument/diagnostic", { textDocument: { uri } })).items,
    ).toEqual([]);

    lumine.config.set("ide-vue.features.diagnostics", false);
    lumine.config.set("ide-vue.vue.suggest.componentNameCasing", "alwaysKebabCase");
    client.notify("workspace/didChangeConfiguration", {
      settings: adapter.getSettings(),
    });
    expect(adapter.getWorkspaceConfiguration("typescript.validate.enable")).toBe(false);
    expect(adapter.getWorkspaceConfiguration("vue.suggest.componentNameCasing")).toBe(
      "alwaysKebabCase",
    );
    client.change(uri, source, 3);
    expect(
      (await client.request("textDocument/diagnostic", { textDocument: { uri } })).items,
    ).toEqual([]);
    client.closeDocument(uri);
  });
});
