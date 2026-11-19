const childProcess = require("child_process");
const Budget = require("./bridge-budget");
const path = require("path");

const REQUEST_TIMEOUT = 15000;
const STOP_TIMEOUT = 1000;
const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_REQUESTS = 256;
const suspended = () =>
  new DOMException("Vue document synchronization was suspended", "AbortError");

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
    this.retainedUnits = 0;
    this.requestsForFile = new Map();
    this.activeRequests = 0;
    this.diskReadTail = Promise.resolve();
    this.resetReader();
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
    this.resetReader();
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
    child.stdin.on("error", (error) => {
      if (this.child === child && !this.stopping) this.failTransport(error);
    });
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
    this.clearFiles(error);
    this.resetReader();
  }

  clearFiles(error) {
    for (const state of this.requestsForFile.values()) state.readAbort?.abort(error);
    this.requestsForFile.clear();
    this.openFiles.clear();
    this.retainedUnits = 0;
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
    this.resetReader();
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

  resetReader() {
    this.buffer = Buffer.alloc(0);
    this.bodyLength = 0;
    this.bodyReceived = 0;
    this.bodyChunks = [];
  }

  receive(chunk) {
    while (chunk.length) {
      if (!this.bodyLength) {
        if (this.buffer.length) chunk = Buffer.concat([this.buffer, chunk]);
        const headerEnd = chunk.indexOf(HEADER_END);
        if (headerEnd < 0) {
          const extra = chunk.length - 8192;
          if (
            extra <= 0 ||
            (extra < HEADER_END.length &&
              HEADER_END.subarray(0, extra).equals(chunk.subarray(-extra)))
          ) {
            this.buffer = chunk;
            return;
          }
        }
        if (headerEnd < 0 || headerEnd > 8192)
          return this.failTransport(
            Budget.failure("response header exceeds its transport budget."),
          );
        const header = chunk.subarray(0, headerEnd).toString("ascii");
        const length = Number(header.match(/^Content-Length:\s*(\d+)\r?$/im)?.[1]);
        if (!Number.isSafeInteger(length) || length <= 0 || length > Budget.FRAME_LIMIT)
          return this.failTransport(Budget.failure("response has an invalid transport length."));
        this.bodyLength = length;
        this.buffer = Buffer.alloc(0);
        chunk = chunk.subarray(headerEnd + HEADER_END.length);
      }
      const count = Math.min(this.bodyLength - this.bodyReceived, chunk.length);
      if (count) this.bodyChunks.push(chunk.subarray(0, count));
      this.bodyReceived += count;
      if (this.bodyReceived < this.bodyLength) return;
      const body = Buffer.concat(this.bodyChunks, this.bodyLength).toString("utf8");
      chunk = chunk.subarray(count);
      this.resetReader();
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      if (message?.type !== "response") continue;
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
    if (responseRequired && this.pending.size >= MAX_REQUESTS)
      throw Budget.failure("has too many pending requests.");
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
    const state = this.requestsForFile.get(file);
    this.requestsForFile.delete(file);
    state?.readAbort?.abort(suspended());
    for (const [sequence, pending] of this.pending) {
      if (pending.file !== file) continue;
      clearTimeout(pending.timer);
      this.pending.delete(sequence);
      pending.reject(suspended());
    }
    const previous = this.openFiles.get(file);
    if (this.openFiles.delete(file)) {
      this.retainedUnits -= previous.length;
      try {
        this.write("close", { file }, false);
      } catch (error) {
        this.failTransport(error);
        throw error;
      }
    }
  }

  ensureOpen(file, text) {
    Budget.assertText(text);
    const previous = this.openFiles.get(file);
    const retained = this.retainedUnits - (previous?.length ?? 0) + text.length;
    if (retained > Budget.RETAINED_LIMIT || (previous === undefined && this.openFiles.size >= 4096))
      throw Budget.failure("retained documents exceed its synchronization budget.");
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
    this.retainedUnits = retained;
  }

  readDiskText(file, state) {
    if (!state.read) {
      state.readAbort = new AbortController();
      state.read = this.diskReadTail.then(() => Budget.readText(file, state.readAbort.signal));
      this.diskReadTail = state.read.then(
        () => {},
        () => {},
      );
    }
    return state.read;
  }

  async request(command, args) {
    if (this.stopping || this.stopped) throw new Error("Vue tsserver bridge is stopped");
    if (this.activeRequests >= MAX_REQUESTS) throw Budget.failure("has too many pending requests.");
    this.activeRequests++;
    const file = requestFile(args);
    let state;
    try {
      if (file) {
        state = this.requestsForFile.get(file);
        if (!state) this.requestsForFile.set(file, (state = { users: 0 }));
        state.users++;
        try {
          let text = this.textForFile(file);
          if (text === undefined) {
            const disk = await this.readDiskText(file, state);
            if (this.requestsForFile.get(file) !== state) throw suspended();
            text = this.textForFile(file);
            state.diskSource = text === undefined;
            if (state.diskSource) text = disk;
          } else {
            state.diskSource = false;
          }
          if (text === null) {
            this.suspendFile(file);
            return null;
          }
          this.ensureOpen(file, text);
        } catch (error) {
          if (this.requestsForFile.get(file) === state) this.suspendFile(file);
          throw error;
        }
      }
      return await this.write(command, args, true);
    } finally {
      this.activeRequests--;
      if (state && this.requestsForFile.get(file) === state && --state.users === 0) {
        if (state.diskSource) this.suspendFile(file);
        else this.requestsForFile.delete(file);
      }
    }
  }

  kill() {
    void this.stop().catch(() => {});
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
    const error = new Error("Vue tsserver bridge stopped");
    this.rejectPending(error);
    this.clearFiles(error);

    const child = this.child;
    if (!child) {
      this.stopChild = null;
      this.child = null;
      this.stopping = false;
      this.stopped = true;
      this.resetReader();
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
