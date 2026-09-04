const childProcess = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const main = require("../lib/main");
const {
  bundledPluginProbeLocation,
  bundledTsdk,
  managedServer,
  pluginProbeLocation,
  resolveServer,
  resolveTsdk,
} = require("../lib/server");
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
      pluginProbeLocation: bundledPluginProbeLocation(),
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
    expect(launch.pluginProbeLocation).toBe(bundledPluginProbeLocation());
    expect(require("@vue/language-server/package.json").version).toBe("3.3.11");
    expect(require("@vue/typescript-plugin/package.json").version).toBe("3.3.11");
    expect(require("typescript/package.json").version).toBe("6.0.3");
  });

  it("keeps the managed compiler below TypeScript 7 and probes its matching Vue plugin", () => {
    const directory = path.join("managed", "ide-vue");
    expect(managedServer.packages).toEqual([
      "@vue/language-server",
      { name: "typescript", version: "^6.0.3" },
    ]);
    expect(pluginProbeLocation("", { directory })).toBe(path.join(directory, "node_modules"));
    expect(pluginProbeLocation(process.execPath, { directory })).toBe(bundledPluginProbeLocation());
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
      await bridge.stop();
    }
  });

  it("coalesces stop, rejects pending requests and kills an unresponsive process", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: jasmine.createSpy("write") };
    child.kill = jasmine.createSpy("kill").and.callFake((signal) => {
      expect(signal).toBe("SIGKILL");
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    });
    spyOn(childProcess, "spawn").and.returnValue(child);
    let forceStop;
    const timer = { unref: jasmine.createSpy("unref") };
    const timers = {
      setTimeout(callback, delay) {
        expect(delay).toBe(1000);
        forceStop = callback;
        return timer;
      },
      clearTimeout: jasmine.createSpy("clearTimeout"),
    };
    const managedProbe = path.join(__dirname, "managed", "node_modules");
    const bridge = new TsServerBridge({
      rootPath: __dirname,
      tsdk: bundledTsdk(),
      pluginProbeLocation: managedProbe,
      textForFile: () => undefined,
      timers,
    });
    const pending = bridge.request("_vue:projectInfo", {});
    const rejected = expectAsync(pending).toBeRejectedWithError("Vue tsserver bridge stopped");

    const first = bridge.stop();
    const second = bridge.stop();

    expect(second).toBe(first);
    const spawnArgs = childProcess.spawn.calls.mostRecent().args[1];
    expect(spawnArgs[spawnArgs.indexOf("--pluginProbeLocations") + 1]).toBe(managedProbe);
    await rejected;
    expect(JSON.parse(child.stdin.write.calls.mostRecent().args[0]).command).toBe("exit");
    expect(timer.unref).toHaveBeenCalledTimes(1);
    forceStop();
    await first;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(timers.clearTimeout).toHaveBeenCalledOnceWith(timer);
    expect(() => bridge.request("_vue:projectInfo", {})).toThrowError(
      "Vue tsserver bridge is stopped",
    );
  });

  it("does not report a stopped bridge when the hard kill cannot be sent", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {} };
    child.kill = jasmine.createSpy("kill").and.returnValue(false);
    spyOn(childProcess, "spawn").and.returnValue(child);
    let forceStop;
    const timers = {
      setTimeout(callback) {
        forceStop = callback;
        return {};
      },
      clearTimeout() {},
    };
    const bridge = new TsServerBridge({
      rootPath: __dirname,
      tsdk: bundledTsdk(),
      textForFile: () => undefined,
      timers,
    });
    bridge.request("_vue:projectInfo", {}).catch(() => {});
    const stopping = bridge.stop();

    forceStop();

    await expectAsync(stopping).toBeRejectedWithError("Unable to kill Vue tsserver bridge");
    expect(bridge.stopped).toBe(false);
    expect(bridge.child).toBe(child);
  });
});

describe("ide-vue adapter", () => {
  let adapter;
  let disposable;

  beforeEach(async () => {
    lumine.config.unset("ide-vue.tsdk");
    await lumine.packages.activatePackage("ide-vue");
    ({ adapter, disposable } = registerAdapter());
  });

  afterEach(async () => {
    disposable.dispose();
    lumine.config.unset("ide-vue.tsdk");
    await lumine.packages.deactivatePackage("ide-vue");
  });

  it("registers Vue SFCs as project-scoped stdio sessions", async () => {
    expect(adapter.id).toBe("ide-vue");
    expect(adapter.displayName).toBe("Vue Language Server");
    expect(adapter.grammarScopes).toEqual(["text.html.vue"]);
    expect(adapter.languageId).toBe("vue");
    expect(adapter.sessionScope).toBe("project-root");
    expect(adapter.settingsKeyPaths).toEqual(["ide-vue"]);
    expect(adapter.restartKeyPaths).toEqual(["ide-vue.serverPath", "ide-vue.tsdk"]);
    const launch = await adapter.resolveServer({ rootPath: __dirname });
    expect(launch.cwd).toBe(__dirname);
    expect(launch.transport).toBe("stdio");
    expect(launch.tsdk).toBe(bundledTsdk());
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

  it("uses the Vue grammar override when server-side feature settings are built", () => {
    lumine.config.set("ide-vue.features.diagnostics", false);
    lumine.config.set("ide-vue.features.diagnostics", true, {
      scopeSelector: ".text.html.vue",
    });
    expect(adapter.getSettings().typescript.validate.enable).toBe(true);
    expect(adapter.getSettings().html.validate).toBe(true);
    lumine.config.unset("ide-vue.features.diagnostics", {
      scopeSelector: ".text.html.vue",
    });
  });

  it("bridges Volar's nonstandard tsserver request and response notifications", async () => {
    let bridgeTsdk;
    spyOn(TsServerBridge.prototype, "request").and.callFake(function () {
      bridgeTsdk = this.tsdk;
      return Promise.resolve(["ChildCard"]);
    });
    spyOn(TsServerBridge.prototype, "kill");
    lumine.config.set("ide-vue.tsdk", "C:\\invalid-new-tsdk");
    const session = {
      rootPath: __dirname,
      launch: { tsdk: bundledTsdk() },
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
    expect(bridgeTsdk).toBe(session.launch.tsdk);
    expect(session.notify).toHaveBeenCalledOnceWith("tsserver/response", [17, ["ChildCard"]]);
    await adapter.handleServerNotification("window/logMessage", {}, { session });
    expect(session.notify).toHaveBeenCalledTimes(1);
    lumine.config.unset("ide-vue.tsdk");
    disposable.dispose();
    expect(TsServerBridge.prototype.kill).toHaveBeenCalledTimes(1);
  });

  it("reports one bridge failure while still answering every server request", async () => {
    spyOn(TsServerBridge.prototype, "request").and.returnValue(
      Promise.reject(new Error("bridge exploded")),
    );
    spyOn(lumine.notifications, "addError");
    const session = {
      rootPath: __dirname,
      launch: { tsdk: bundledTsdk() },
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
    spyOn(TsServerBridge.prototype, "stop").and.returnValue(Promise.resolve());
    const session = {
      adapter,
      rootPath: __dirname,
      launch: { tsdk: bundledTsdk() },
      notify() {},
    };
    await adapter.handleServerNotification(
      "tsserver/request",
      [1, "_vue:projectInfo", { file: "App.vue" }],
      { session },
    );
    changeSession({ session, state: "stopped" });
    expect(TsServerBridge.prototype.stop).toHaveBeenCalledOnceWith();
  });

  it("does not create a companion process for a session that is stopping", async () => {
    spyOn(TsServerBridge.prototype, "request");
    const session = {
      rootPath: __dirname,
      state: "stopping",
      notify: jasmine.createSpy("notify"),
    };
    await adapter.handleServerNotification(
      "tsserver/request",
      [1, "_vue:projectInfo", { file: "App.vue" }],
      { session },
    );
    expect(TsServerBridge.prototype.request).not.toHaveBeenCalled();
    expect(session.notify).not.toHaveBeenCalled();
  });

  it("does not answer a bridge request after its session starts stopping", async () => {
    disposable.dispose();
    let changeSession;
    ({ adapter, disposable } = registerAdapter({
      onDidChangeSession(callback) {
        changeSession = callback;
        return { dispose() {} };
      },
    }));
    let resolveRequest;
    spyOn(TsServerBridge.prototype, "request").and.returnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    spyOn(TsServerBridge.prototype, "stop").and.returnValue(Promise.resolve());
    const session = {
      adapter,
      rootPath: __dirname,
      launch: { tsdk: bundledTsdk() },
      state: "running",
      notify: jasmine.createSpy("notify"),
    };
    const handling = adapter.handleServerNotification(
      "tsserver/request",
      [1, "_vue:projectInfo", { file: "App.vue" }],
      { session },
    );
    session.state = "stopping";
    changeSession({ session, state: "stopping" });
    resolveRequest({ configFileName: "tsconfig.json" });
    await handling;
    expect(TsServerBridge.prototype.stop).toHaveBeenCalledTimes(1);
    expect(session.notify).not.toHaveBeenCalled();
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

  it("matches Windows paths after the server canonicalizes the drive", () => {
    expect(main.pathKey("C:\\Project\\App.vue", "win32")).toBe(
      main.pathKey("c:/Project/App.vue", "win32"),
    );
    expect(main.pathKey("/Project/App.vue", "linux")).not.toBe(
      main.pathKey("/Project/app.vue", "linux"),
    );
    spyOn(lumine.workspace, "getTextEditors").and.returnValue([
      {
        getPath: () => "C:\\Project\\App.vue",
        getText: () => "unsaved Vue source",
      },
    ]);
    expect(main.textForOpenFile("c:/Project/App.vue", "win32")).toBe("unsaved Vue source");
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
