const childProcess = require("child_process");
const Budget = require("./bridge-budget");
const path = require("path");

const REQUEST_TIMEOUT = 15000;
const STOP_TIMEOUT = 1000;
const HEADER_END = Buffer.from("\r\n\r\n");

const endLocation = (text) => {
  let line = 1,
    start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
    line++;
    start = index + 1;
  }
  return { line, offset: text.length - start + 1 };
};

const requestFile = (args) => {
  if (typeof args?.file === "string") return args.file;
  if (Array.isArray(args) && typeof args[0] === "string") return args[0];
  return null;
};

class TsServerBridge {
  constructor({ rootPath, tsdk, pluginProbeLocation, textForFile, timers }) {
    this.rootPath = rootPath;
    this.tsdk = tsdk;
    this.pluginProbeLocation = pluginProbeLocation;
    this.textForFile = textForFile;
    this.timers = timers || {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    this.sequence = 0;
    this.pending = new Map();
    this.openFiles = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.stopping = false;
    this.stopped = false;
    this.stopPromise = null;
  }

  start() {
    if (this.stopping || this.stopped) throw new Error("Vue tsserver bridge is stopped");
    if (this.child) return;
    const pluginProbeLocation =
      this.pluginProbeLocation ||
      path.resolve(
        path.dirname(require.resolve("@vue/typescript-plugin/package.json")),
        "..",
        "..",
      );
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    const child = childProcess.spawn(
      process.execPath,
      [
        require.resolve("./start-typescript"),
        this.tsdk,
        path.join(pluginProbeLocation, "@vue", "typescript-plugin", "package.json"),
        "--globalPlugins",
        "@vue/typescript-plugin",
        "--pluginProbeLocations",
        pluginProbeLocation,
        "--useInferredProjectPerProjectRoot",
        "--disableAutomaticTypingAcquisition",
      ],
      {
        cwd: this.rootPath,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          // Go reads this at process startup. Set it before loading the bridge
          // so the upstream SDK does not re-exec and discard our bootstrap.
          GODEBUG: [process.env.GODEBUG, "asyncpreemptoff=1"].filter(Boolean).join(","),
          TNB_PARENT_PID: String(process.pid),
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.on("data", (chunk) => {
      if (this.child === child) this.receive(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (this.child === child) this.stderr = (this.stderr + chunk.toString()).slice(-65536);
    });
    child.on("exit", (code, signal) => {
      const isCurrent = this.child === child;
      const error = new Error(
        `Vue tsserver exited with code ${code}, signal ${signal}; ${this.stderr}`,
      );
      if (isCurrent) this.child = null;
      if (this.stopping) this.finishStop(child);
      else if (isCurrent) this.handleUnexpectedExit(error);
    });
    child.on("error", (error) => {
      const isCurrent = this.child === child;
      if (isCurrent) this.child = null;
      if (this.stopping) this.finishStop(child);
      else if (isCurrent) this.handleUnexpectedExit(error);
    });
  }

  handleUnexpectedExit(error) {
    this.rejectPending(error);
    this.openFiles.clear();
    this.buffer = Buffer.alloc(0);
  }

  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  finishStop(child) {
    if (this.stopChild !== child) return;
    this.timers.clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.stopChild = null;
    this.child = null;
    this.stopping = false;
    this.stopped = true;
    this.openFiles.clear();
    this.buffer = Buffer.alloc(0);
    this.resolveStop?.();
    this.resolveStop = null;
    this.rejectStop = null;
  }

  failStop(child, error) {
    if (this.stopChild !== child) return;
    this.timers.clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.rejectStop?.(error);
    this.resolveStop = null;
    this.rejectStop = null;
  }

  forceStop(child) {
    try {
      if (!child.kill("SIGKILL")) throw new Error("Unable to kill Vue tsserver bridge");
    } catch (error) {
      this.failStop(child, error);
    }
  }

  receive(chunk) {
    if (this.buffer.length + chunk.length > Budget.FRAME_LIMIT + 8192)
      return this.failTransport(Budget.failure("response exceeds its transport budget."));
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) {
        if (this.buffer.length > 8192)
          this.failTransport(Budget.failure("response header exceeds its transport budget."));
        return;
      }
      if (headerEnd > 8192)
        return this.failTransport(Budget.failure("response header exceeds its transport budget."));
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isSafeInteger(length) || length < 0) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      if (length > Budget.FRAME_LIMIT)
        return this.failTransport(Budget.failure("response exceeds its transport budget."));
      const bodyStart = headerEnd + HEADER_END.length;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      if (message.type !== "response") continue;
      const pending = this.pending.get(message.request_seq);
      if (!pending) continue;
      this.pending.delete(message.request_seq);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.body);
      else pending.reject(new Error(message.message || "Vue tsserver request failed"));
    }
  }

  failTransport(error) {
    const child = this.child;
    this.child = null;
    this.handleUnexpectedExit(error);
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  write(command, args, responseRequired) {
    if (this.pending.size >= 256) throw Budget.failure("has too many pending requests.");
    const frame = Budget.prepareFrame({
      seq: this.sequence + 1,
      type: "request",
      command,
      arguments: args,
    });
    if ((this.child?.stdin?.writableLength ?? 0) + Buffer.byteLength(frame) > Budget.FRAME_LIMIT)
      throw Budget.failure("write queue exceeds its transport budget.");
    this.start();
    const child = this.child;
    const seq = ++this.sequence;
    let response;
    if (responseRequired) {
      response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(seq);
          reject(
            new Error(
              `Vue tsserver ${command} timed out after ${REQUEST_TIMEOUT}ms; ${this.stderr}`,
            ),
          );
        }, REQUEST_TIMEOUT);
        this.pending.set(seq, { resolve, reject, timer, file: requestFile(args) });
      });
    }
    try {
      child.stdin.write(frame);
    } catch (error) {
      const pending = this.pending.get(seq);
      if (!pending) throw error;
      this.pending.delete(seq);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    return response;
  }

  suspendFile(file) {
    for (const [sequence, pending] of this.pending) {
      if (pending.file !== file) continue;
      clearTimeout(pending.timer);
      this.pending.delete(sequence);
      pending.reject(
        Object.assign(new Error("Vue document synchronization was suspended"), {
          name: "AbortError",
        }),
      );
    }
    const hadFile = this.openFiles.delete(file);
    if (hadFile) this.write("close", { file }, false);
  }

  ensureOpen(file) {
    if (!file) return true;
    let openText;
    try {
      openText = this.textForFile(file);
    } catch (error) {
      this.suspendFile(file);
      throw error;
    }
    if (openText === null) {
      this.suspendFile(file);
      return false;
    }
    let text;
    try {
      text = Budget.assertText(openText ?? Budget.readText(file));
      let retained = text.length;
      for (const [name, value] of this.openFiles) if (name !== file) retained += value.length;
      if (
        retained > Budget.RETAINED_LIMIT ||
        (!this.openFiles.has(file) && this.openFiles.size >= 4096)
      )
        throw Budget.failure("retained documents exceed its synchronization budget.");
    } catch (error) {
      this.suspendFile(file);
      throw error;
    }
    const previous = this.openFiles.get(file);
    if (previous === undefined) {
      this.write(
        "open",
        {
          file,
          fileContent: text,
          projectRootPath: this.rootPath,
          scriptKindName: "TS",
        },
        false,
      );
    } else if (previous !== text) {
      this.write(
        "updateOpen",
        {
          changedFiles: [
            {
              fileName: file,
              textChanges: [
                {
                  start: { line: 1, offset: 1 },
                  end: endLocation(previous),
                  newText: text,
                },
              ],
            },
          ],
        },
        false,
      );
    }
    this.openFiles.set(file, text);
    return true;
  }

  request(command, args) {
    if (!this.ensureOpen(requestFile(args))) return Promise.resolve(null);
    return this.write(command, args, true);
  }

  kill() {
    const child = this.child || this.stopChild;
    if (!child) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // The window or package is already going away; there is no async caller
      // left to report a process that disappeared between lookup and kill.
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = new Promise((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    this.rejectPending(new Error("Vue tsserver bridge stopped"));

    const child = this.child;
    if (!child) {
      this.stopChild = null;
      this.child = null;
      this.stopping = false;
      this.stopped = true;
      this.openFiles.clear();
      this.buffer = Buffer.alloc(0);
      this.resolveStop();
      this.resolveStop = null;
      this.rejectStop = null;
      return this.stopPromise;
    }

    this.stopChild = child;
    this.stopTimer = this.timers.setTimeout(() => {
      if (this.stopChild !== child) return;
      this.forceStop(child);
    }, STOP_TIMEOUT);
    this.stopTimer.unref?.();
    try {
      const seq = ++this.sequence;
      child.stdin.write(
        `${JSON.stringify({ seq, type: "request", command: "exit", arguments: {} })}\n`,
      );
    } catch {
      this.forceStop(child);
    }
    return this.stopPromise;
  }
}

exports.TsServerBridge = TsServerBridge;
exports.endLocation = endLocation;
exports.requestFile = requestFile;
