const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const REQUEST_TIMEOUT = 15000;
const STOP_TIMEOUT = 1000;
const HEADER_END = Buffer.from("\r\n\r\n");

const endLocation = (text) => {
  const lines = text.split(/\r\n|\n|\r/);
  return { line: lines.length, offset: lines.at(-1).length + 1 };
};

const requestFile = (args) => {
  if (typeof args?.file === "string") return args.file;
  if (Array.isArray(args) && typeof args[0] === "string") return args[0];
  return null;
};

class TsServerBridge {
  constructor({ rootPath, tsdk, textForFile, timers }) {
    this.rootPath = rootPath;
    this.tsdk = tsdk;
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
    const tsserver = path.join(this.tsdk, "tsserver.js");
    const pluginManifest = require.resolve("@vue/typescript-plugin/package.json");
    const pluginProbeLocation = path.resolve(path.dirname(pluginManifest), "..", "..");
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    const child = childProcess.spawn(
      process.execPath,
      [
        tsserver,
        "--globalPlugins",
        "@vue/typescript-plugin",
        "--pluginProbeLocations",
        pluginProbeLocation,
        "--allowLocalPluginLoads",
        "--useInferredProjectPerProjectRoot",
        "--disableAutomaticTypingAcquisition",
      ],
      {
        cwd: this.rootPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.on("data", (chunk) => {
      if (this.child === child) this.receive(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (this.child === child) this.stderr += chunk.toString();
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
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
        continue;
      }
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

  write(command, args, responseRequired) {
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
        this.pending.set(seq, { resolve, reject, timer });
      });
    }
    try {
      child.stdin.write(`${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`);
    } catch (error) {
      const pending = this.pending.get(seq);
      if (!pending) throw error;
      this.pending.delete(seq);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    return response;
  }

  ensureOpen(file) {
    if (!file) return;
    const text = this.textForFile(file) ?? fs.readFileSync(file, "utf8");
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
  }

  request(command, args) {
    this.ensureOpen(requestFile(args));
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
