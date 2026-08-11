const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const REQUEST_TIMEOUT = 15000;
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
  constructor({ rootPath, tsdk, textForFile }) {
    this.rootPath = rootPath;
    this.tsdk = tsdk;
    this.textForFile = textForFile;
    this.sequence = 0;
    this.pending = new Map();
    this.openFiles = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
  }

  start() {
    if (this.child) return;
    const tsserver = path.join(this.tsdk, "tsserver.js");
    const pluginManifest = require.resolve("@vue/typescript-plugin/package.json");
    const pluginProbeLocation = path.resolve(path.dirname(pluginManifest), "..", "..");
    this.child = childProcess.spawn(
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
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `Vue tsserver exited with code ${code}, signal ${signal}; ${this.stderr}`,
      );
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.child = null;
    });
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
    this.child.stdin.write(
      `${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`,
    );
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

  stop() {
    if (!this.child) return;
    try {
      this.write("exit", {}, false);
    } catch {
      this.child.kill();
    }
    this.child = null;
  }
}

exports.TsServerBridge = TsServerBridge;
exports.endLocation = endLocation;
exports.requestFile = requestFile;
