const fs = require("fs");
const path = require("path");
const main = require("../lib/main");
const { bundledTsdk, resolveServer, resolveTsdk } = require("../lib/server");
const { TsServerBridge, endLocation, requestFile } = require("../lib/tsserver-bridge");

const FEATURES = [
  "diagnostics",
  "autocomplete",
  "hover",
  "definition",
  "references",
  "symbols",
  "format",
  "rename",
  "codeActions",
  "inlayHints",
  "semanticTokens",
];

const registerAdapter = (overrides = {}) => {
  let adapter;
  const service = {
    registerAdapter(registered) {
      adapter = registered;
      return { dispose() {} };
    },
    getSessions: () => [],
    restart: async () => {},
    ...overrides,
  };
  const disposable = main.consumeIdeClient(service);
  return { adapter, disposable, service };
};

describe("ide-vue server resolution", () => {
  it("uses the configured executable and TypeScript SDK with stdio", async () => {
    const launch = await resolveServer(process.execPath, bundledTsdk());
    expect(launch).toEqual({
      command: process.execPath,
      args: ["--stdio", `--tsdk=${bundledTsdk()}`],
    });
  });

  it("launches the exact bundled server through Electron's Node runtime", async () => {
    const tsdk = resolveTsdk("");
    const launch = await resolveServer("", tsdk);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args.slice(1)).toEqual(["--stdio", `--tsdk=${tsdk}`]);
    expect(path.basename(launch.args[0])).toBe("vue-language-server.js");
    expect(fs.existsSync(launch.args[0])).toBe(true);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(require("@vue/language-server/package.json").version).toBe("3.3.11");
    expect(require("@vue/typescript-plugin/package.json").version).toBe("3.3.11");
    expect(require("typescript/package.json").version).toBe("6.0.3");
  });

  it("rejects missing custom executables and TypeScript SDKs", async () => {
    await expectAsync(resolveServer("", path.join(__dirname, "missing"))).toBeRejected();
    await expectAsync(
      resolveServer(path.join(__dirname, "missing-server"), bundledTsdk()),
    ).toBeRejected();
  });
});

describe("ide-vue TypeScript bridge primitives", () => {
  it("computes one-based tsserver end locations for every newline spelling", () => {
    expect(endLocation("one\ntwo")).toEqual({ line: 2, offset: 4 });
    expect(endLocation("one\r\ntwo\r\n")).toEqual({ line: 3, offset: 1 });
    expect(endLocation("")).toEqual({ line: 1, offset: 1 });
  });

  it("finds Vue files in both custom notification argument shapes", () => {
    expect(requestFile({ file: "App.vue" })).toBe("App.vue");
    expect(requestFile(["ChildCard.vue", true])).toBe("ChildCard.vue");
    expect(requestFile({ path: "App.vue" })).toBeNull();
    expect(requestFile()).toBeNull();
  });

  it("opens, updates and forwards requests through one tsserver process", async () => {
    const rootPath = path.join(__dirname, "fixtures", "drive");
    const file = path.join(rootPath, "App.vue");
    let text = fs.readFileSync(file, "utf8");
    const bridge = new TsServerBridge({
      rootPath,
      tsdk: bundledTsdk(),
      textForFile: () => text,
    });
    try {
      const project = await bridge.request("_vue:projectInfo", {
        file,
        needFileNameList: false,
      });
      expect(path.normalize(project.configFileName)).toBe(
        path.normalize(path.join(rootPath, "tsconfig.json")),
      );
      expect(project.languageServiceDisabled).toBe(false);
      const components = await bridge.request("_vue:getComponentNames", [file]);
      expect(components).toContain("ChildCard");
      const templateStart = text.indexOf("<template>") + "<template>".length;
      const componentStart = text.indexOf("<ChildCard") - templateStart;
      const props = await bridge.request("_vue:getComponentProps", [file, componentStart]);
      expect(props.map(({ name }) => name)).toContain("count");
      text = text.replace("const count = ref(1)", "const count = ref(2)");
      const updated = await bridge.request("_vue:getComponentNames", [file]);
      expect(updated).toContain("count");
      expect(bridge.openFiles.get(file)).toBe(text);
    } finally {
      bridge.stop();
    }
  });
});

describe("ide-vue adapter", () => {
  let adapter;
  let disposable;

  beforeEach(async () => {
    await lumine.packages.activatePackage("ide-vue");
    ({ adapter, disposable } = registerAdapter());
  });

  afterEach(async () => {
    disposable.dispose();
    await lumine.packages.deactivatePackage("ide-vue");
  });

  it("registers Vue SFCs as project-scoped stdio sessions", async () => {
    expect(adapter.id).toBe("ide-vue");
    expect(adapter.displayName).toBe("Vue Language Server");
    expect(adapter.grammarScopes).toEqual(["text.html.vue"]);
    expect(adapter.languageId).toBe("vue");
    expect(adapter.sessionScope).toBe("project-root");
    expect(adapter.settingsKeyPaths).toEqual(["ide-vue"]);
    const launch = await adapter.resolveServer({ rootPath: __dirname });
    expect(launch.cwd).toBe(__dirname);
    expect(launch.transport).toBe("stdio");
  });

  it("answers whole, top-level and deeply nested configuration sections", () => {
    lumine.config.set("ide-vue.vue.format.template.initialIndent", false);
    lumine.config.set("ide-vue.typescript.preferences.quoteStyle", "single");
    const all = adapter.getSettings();
    expect(adapter.getWorkspaceConfiguration()).toEqual(all);
    expect(adapter.getWorkspaceConfiguration("vue")).toEqual(all.vue);
    expect(adapter.getWorkspaceConfiguration("vue.format.template")).toEqual({
      enabled: true,
      initialIndent: false,
    });
    expect(adapter.getWorkspaceConfiguration("typescript.preferences.quoteStyle")).toBe("single");
    expect(adapter.getWorkspaceConfiguration("javascript")).toEqual(all.typescript);
    expect(adapter.getWorkspaceConfiguration("editor")).toBeUndefined();
  });

  it("maps Vue, embedded-language and TypeScript settings without flattening them", () => {
    lumine.config.set("ide-vue.features.diagnostics", false);
    lumine.config.set("ide-vue.features.autocomplete", false);
    lumine.config.set("ide-vue.features.hover", false);
    lumine.config.set("ide-vue.features.format", false);
    lumine.config.set("ide-vue.vue.suggest.componentNameCasing", "alwaysPascalCase");
    lumine.config.set("ide-vue.vue.inlayHints.missingProps", true);
    lumine.config.set("ide-vue.typescript.inlayHints.parameterNames", "all");
    lumine.config.set("ide-vue.html.autoClosingTags", false);
    const all = adapter.getSettings();
    expect(all.vue.suggest.componentNameCasing).toBe("alwaysPascalCase");
    expect(all.vue.inlayHints.missingProps).toBe(true);
    expect(all.typescript.validate.enable).toBe(false);
    expect(all.typescript.suggest.enabled).toBe(false);
    expect(all.typescript.inlayHints.parameterNames.enabled).toBe("all");
    expect(all.typescript.format.enable).toBe(false);
    expect(all.javascript).toEqual(all.typescript);
    expect(all.html).toEqual({
      validate: false,
      format: { enable: false },
      completion: { autoClosingTags: false, autoCreateQuotes: true },
      hover: { documentation: false },
    });
    expect(all.css).toEqual({ validate: false, format: { enable: false } });
    expect(all.scss).toEqual(all.css);
    expect(all.less).toEqual(all.css);
  });

  it("bridges Volar's nonstandard tsserver request and response notifications", async () => {
    spyOn(TsServerBridge.prototype, "request").and.returnValue(Promise.resolve(["ChildCard"]));
    spyOn(TsServerBridge.prototype, "stop");
    const session = {
      rootPath: __dirname,
      notify: jasmine.createSpy("notify"),
    };
    await adapter.handleServerNotification(
      "tsserver/request",
      [[17, "_vue:getComponentNames", ["App.vue"]]],
      { session },
    );
    expect(TsServerBridge.prototype.request).toHaveBeenCalledOnceWith("_vue:getComponentNames", [
      "App.vue",
    ]);
    expect(session.notify).toHaveBeenCalledOnceWith("tsserver/response", [17, ["ChildCard"]]);
    await adapter.handleServerNotification("window/logMessage", {}, { session });
    expect(session.notify).toHaveBeenCalledTimes(1);
    disposable.dispose();
    expect(TsServerBridge.prototype.stop).toHaveBeenCalledTimes(1);
  });

  it("reports one bridge failure while still answering every server request", async () => {
    spyOn(TsServerBridge.prototype, "request").and.returnValue(
      Promise.reject(new Error("bridge exploded")),
    );
    spyOn(lumine.notifications, "addError");
    const session = {
      rootPath: __dirname,
      notify: jasmine.createSpy("notify"),
    };
    await adapter.handleServerNotification("tsserver/request", [1, "first", { file: "App.vue" }], {
      session,
    });
    await adapter.handleServerNotification("tsserver/request", [2, "second", { file: "App.vue" }], {
      session,
    });
    expect(session.notify.calls.allArgs()).toEqual([
      ["tsserver/response", [1, null]],
      ["tsserver/response", [2, null]],
    ]);
    expect(lumine.notifications.addError).toHaveBeenCalledTimes(1);
    expect(lumine.notifications.addError.calls.first().args[1].detail).toContain("bridge exploded");
  });

  it("stops companion processes with their sessions", async () => {
    disposable.dispose();
    let changeSession;
    ({ adapter, disposable } = registerAdapter({
      onDidChangeSession(callback) {
        changeSession = callback;
        return { dispose() {} };
      },
    }));
    spyOn(TsServerBridge.prototype, "request").and.returnValue(Promise.resolve({}));
    spyOn(TsServerBridge.prototype, "stop");
    const session = { adapter, rootPath: __dirname, notify() {} };
    await adapter.handleServerNotification(
      "tsserver/request",
      [1, "_vue:projectInfo", { file: "App.vue" }],
      { session },
    );
    changeSession({ session, state: "stopped" });
    expect(TsServerBridge.prototype.stop).toHaveBeenCalledOnceWith();
  });

  it("restarts active sessions after either launch path changes", async () => {
    disposable.dispose();
    const active = { adapter: null, state: "running" };
    const stopped = { adapter: null, state: "stopped" };
    const restart = jasmine.createSpy("restart").and.returnValue(Promise.resolve());
    ({ adapter, disposable } = registerAdapter({
      getSessions: () => [active, stopped],
      restart,
    }));
    active.adapter = adapter;
    stopped.adapter = adapter;
    lumine.config.set("ide-vue.serverPath", process.execPath);
    lumine.config.set("ide-vue.tsdk", bundledTsdk());
    await Promise.resolve();
    expect(restart.calls.allArgs()).toEqual([[active], [active]]);
  });
});

describe("ide-vue feature contracts", () => {
  const definitions = require("../package.json").configSchema.features.properties;

  beforeEach(async () => {
    await lumine.packages.activatePackage("ide-vue");
  });

  afterEach(async () => {
    for (const feature of FEATURES) lumine.config.unset(`ide-vue.features.${feature}`);
    await lumine.packages.deactivatePackage("ide-vue");
  });

  it("declares exactly the features served by the adapter", () => {
    expect(Object.keys(definitions)).toEqual(FEATURES);
  });

  for (const feature of FEATURES) {
    it(`exposes ${feature} as an independent enabled-by-default switch`, () => {
      expect(definitions[feature].type).toBe("boolean");
      expect(definitions[feature].default).toBe(true);
      const keyPath = `ide-vue.features.${feature}`;
      expect(lumine.config.get(keyPath)).toBe(true);
      lumine.config.set(keyPath, false);
      expect(lumine.config.get(keyPath)).toBe(false);
    });
  }
});

describe("ide-vue package assets", () => {
  const root = path.join(__dirname, "..");
  const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
  const pkg = require("../package.json");
  const readme = read("README.md");

  it("uses one canonical short description", () => {
    expect(readme.split(/\r?\n/).slice(0, 3)).toEqual(["# ide-vue", "", pkg.description]);
    expect(pkg.description).toBe("Vue language-server adapter.");
    expect(pkg.description.length).toBeLessThan(80);
  });

  it("publishes under lumine-code with an MIT license", () => {
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/ide-vue");
    expect(pkg.bugs.url).toBe("https://github.com/lumine-code/ide-vue/issues");
    expect(read("LICENSE")).toContain("Copyright (c) 2026 lumine-code");
  });

  it("pins all bridge runtime dependencies exactly", () => {
    expect(pkg.dependencies).toEqual({
      "@vue/language-server": "3.3.11",
      "@vue/typescript-plugin": "3.3.11",
      typescript: "6.0.3",
    });
    for (const version of Object.values(pkg.dependencies))
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("declares every setting read by the adapter", () => {
    const lookup = (keyPath) =>
      keyPath
        .split(".")
        .reduce(
          (schema, key) => (schema === pkg.configSchema ? schema : schema?.properties)?.[key],
          pkg.configSchema,
        );
    const used = [...read("lib/main.js").matchAll(/setting\("([A-Za-z.]+)"\)/g)].map(
      (match) => match[1],
    );
    for (const keyPath of new Set(used))
      expect(`${keyPath}: ${Boolean(lookup(keyPath))}`).toBe(`${keyPath}: true`);
  });

  it("documents the nonstandard bridge and contains no legacy editor imports", () => {
    expect(readme).toContain("tsserver/request");
    expect(readme).toContain("@vue/typescript-plugin");
    for (const file of ["README.md", "package.json", "lib/main.js"])
      expect(read(file)).not.toMatch(/require\(["']atom["']\)|\bPulsar\b|atom-ide\//);
  });
});
