const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Vue bridge document and transport budgets", () => {
  let Budget, TsServerBridge, main, directory;
  beforeEach(() => {
    jasmine.useRealClock();
    Budget = require("../lib/bridge-budget");
    ({ TsServerBridge } = require("../lib/tsserver-bridge"));
    main = require("../lib/main");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-vue-budget-"));
    lumine.config.set("ide-vue.maxDocumentSize", 0.0625);
  });
  afterEach(() => {
    lumine.config.unset("ide-vue.maxDocumentSize");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("rejects giant open siblings using metadata before source extraction", () => {
    const editor = {
      getPath: () => "sibling.ts",
      getGrammar: () => ({}),
      getBuffer: () => ({ getLength: () => 600000000 }),
      getText: jasmine.createSpy("giant text").and.throwError("must not read"),
    };
    spyOn(lumine.workspace, "getTextEditors").and.returnValue([editor]);
    expect(() => main.textForOpenFile("sibling.ts")).toThrowError(/synchronization budget/);
    expect(editor.getText).not.toHaveBeenCalled();
  });

  it("retires previously synchronized source after eligibility loss and recovers", () => {
    let source = "before";
    const bridge = new TsServerBridge({ textForFile: () => Budget.assertText(source) });
    spyOn(bridge, "write");
    bridge.ensureOpen("sibling.ts");
    source = "x".repeat(65537);
    expect(() => bridge.ensureOpen("sibling.ts")).toThrowError(/synchronization budget/);
    expect(bridge.openFiles.size).toBe(0);
    expect(bridge.write).toHaveBeenCalledWith("close", { file: "sibling.ts" }, false);
    source = "after";
    bridge.ensureOpen("sibling.ts");
    expect(bridge.openFiles.get("sibling.ts")).toBe("after");
  });

  it("closes and cancels the existing bridge document when an editor grows over budget", async () => {
    const { Disposable } = require("lumine");
    const file = path.join(directory, "live.vue");
    fs.writeFileSync(file, "small");
    const editor = await lumine.workspace.open(file);
    spyOn(editor, "getGrammar").and.returnValue({ scopeName: "text.html.vue" });
    let adapter, bridge;
    const original = TsServerBridge.prototype.ensureOpen;
    spyOn(TsServerBridge.prototype, "ensureOpen").and.callFake(function (name) {
      bridge = this;
      return original.call(this, name);
    });
    spyOn(TsServerBridge.prototype, "write");
    const subscription = main.consumeIde({
      registerAdapter(value) {
        adapter = value;
        return new Disposable();
      },
    });
    const session = { state: "running", launch: {}, notify() {} };
    try {
      await adapter.handleServerNotification("tsserver/request", [1, "query", { file }], {
        session,
      });
      expect(bridge.openFiles.has(file)).toBeTrue();
      const reject = jasmine.createSpy("pending request rejected");
      bridge.pending.set(2, { file, reject, timer: setTimeout(() => {}, 1000) });
      editor.setText("x".repeat(65537));
      expect(bridge.openFiles.has(file)).toBeFalse();
      expect(reject.calls.mostRecent().args[0].name).toBe("AbortError");
      expect(bridge.pending.size).toBe(0);
    } finally {
      subscription.dispose();
      editor.destroy();
    }
  });

  it("decodes bounded disk chunks exactly and rejects sparse oversized input before reading", () => {
    const file = path.join(directory, "source.ts");
    const source = "ą😀".repeat(20000);
    fs.writeFileSync(file, source);
    expect(Budget.readText(file)).toBe(source);
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, 600000000);
    fs.closeSync(fd);
    const read = spyOn(fs, "readSync").and.throwError("must not read sparse input");
    expect(() => Budget.readText(file)).toThrowError(/synchronization budget/);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects growth during bounded decoding and closes the descriptor", () => {
    const file = path.join(directory, "growing.ts");
    fs.writeFileSync(file, "x");
    const original = fs.readSync;
    let grown = false;
    spyOn(fs, "readSync").and.callFake((...args) => {
      if (!grown) {
        grown = true;
        fs.appendFileSync(file, "a".repeat(65537));
      }
      return original(...args);
    });
    const close = spyOn(fs, "closeSync").and.callThrough();
    expect(() => Budget.readText(file)).toThrowError(/synchronization budget/);
    expect(close).toHaveBeenCalled();
  });

  it("preflights dense protocol structures before spawning or recording requests", () => {
    const bridge = new TsServerBridge({ textForFile: () => "" });
    spyOn(bridge, "start");
    expect(() => bridge.write("query", new Array(200001).fill(0), true)).toThrowError(/structure/);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.pending.size).toBe(0);
    expect(bridge.sequence).toBe(0);
  });

  it("rejects oversized responses at the header and retires pending state", () => {
    const bridge = new TsServerBridge({ textForFile: () => "" });
    bridge.child = { kill: jasmine.createSpy("kill") };
    const child = bridge.child;
    const reject = jasmine.createSpy("reject");
    bridge.pending.set(1, { reject, timer: setTimeout(() => {}, 1000) });
    bridge.openFiles.set("sibling.ts", "prior");
    bridge.receive(Buffer.from(`Content-Length: ${Budget.FRAME_LIMIT + 1}\r\n\r\n`));
    expect(reject).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(bridge.buffer.length).toBe(0);
    expect(bridge.openFiles.size).toBe(0);
    expect(bridge.pending.size).toBe(0);
  });

  it("rejects runaway headers and accepts complete bounded response chunks", () => {
    const bridge = new TsServerBridge({ textForFile: () => "" });
    const resolve = jasmine.createSpy("resolve");
    bridge.pending.set(1, { resolve, timer: setTimeout(() => {}, 1000) });
    const body = JSON.stringify({ type: "response", request_seq: 1, success: true, body: "ą😀" });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    for (let offset = 0; offset < frame.length; offset += 7)
      bridge.receive(frame.subarray(offset, offset + 7));
    expect(resolve).toHaveBeenCalledOnceWith("ą😀");
    bridge.receive(Buffer.alloc(8193, 65));
    expect(bridge.buffer.length).toBe(0);
  });

  it("counts dense mixed line endings without allocating line arrays", () => {
    const { endLocation } = require("../lib/tsserver-bridge");
    expect(endLocation("\r\n\r\n\n\r".repeat(100000) + "tail")).toEqual({
      line: 400001,
      offset: 5,
    });
  });
});
