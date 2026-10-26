const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");
const DOCUMENT_LIMIT = 32 * 1024 * 1024;
const FRAME_LIMIT = 256 * 1024 * 1024;
const RETAINED_LIMIT = 128 * 1024 * 1024;
const failure = (detail) =>
  Object.assign(new Error(`Vue TypeScript bridge ${detail}`), { code: "ERR_VUE_BRIDGE_BUDGET" });
function textLimit() {
  const value = globalThis.lumine?.config.get("ide-vue.maxDocumentSize");
  return Number.isFinite(value) && value > 0
    ? Math.min(DOCUMENT_LIMIT, Math.floor(value * 1024 * 1024))
    : DOCUMENT_LIMIT;
}
function editorEligible(editor) {
  const length = editor.getBuffer?.()?.getLength?.();
  return length == null || length <= textLimit();
}
function assertText(text) {
  if (typeof text !== "string" || text.length > textLimit())
    throw failure("document exceeds its synchronization budget.");
  return text;
}
function readText(file) {
  const fd = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (before.size > BigInt(textLimit() * 4))
      throw failure("file exceeds its synchronization budget.");
    const decoder = new StringDecoder("utf8"),
      buffer = Buffer.allocUnsafe(65536),
      parts = [];
    let units = 0,
      bytes = 0;
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > textLimit() * 4) throw failure("file grew beyond its synchronization budget.");
      const part = decoder.write(buffer.subarray(0, count));
      units += part.length;
      if (units > textLimit()) throw failure("file exceeds its synchronization budget.");
      parts.push(part);
    }
    const tail = decoder.end();
    if (units + tail.length > textLimit())
      throw failure("file exceeds its synchronization budget.");
    parts.push(tail);
    const after = fs.fstatSync(fd, { bigint: true }),
      current = fs.statSync(file, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      if (before[key] !== after[key] || after[key] !== current[key])
        throw new Error("Vue source changed while reading.");
    return parts.join("");
  } finally {
    fs.closeSync(fd);
  }
}
// These frames contain protocol JSON, never application objects with toJSON hooks.
// A six-byte upper bound per UTF-16 unit covers every JSON escape and UTF-8 encoding.
function prepareFrame(value) {
  let size = 1,
    nodes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++nodes > 200000 || depth > 64)
      throw failure("message structure exceeds its transport budget.");
    if (typeof item === "string") size += 2 + item.length * 6;
    else if (item === null || typeof item === "boolean" || typeof item === "number") size += 24;
    else if (item === undefined) size += 4;
    else if (typeof item === "object") {
      if (ancestors.has(item)) throw new TypeError("Cyclic Vue bridge message");
      const array = Array.isArray(item);
      if (
        !array &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new TypeError("Vue bridge messages must contain plain JSON values");
      ancestors.add(item);
      size += 2;
      if (array)
        for (const child of item) {
          size++;
          visit(child, depth + 1);
        }
      else
        for (const key of Object.keys(item)) {
          size += 4 + key.length * 6;
          visit(item[key], depth + 1);
        }
      ancestors.delete(item);
    } else throw new TypeError("Vue bridge messages must contain JSON values");
    if (size > FRAME_LIMIT) throw failure("message exceeds its transport budget.");
  }
  visit(value, 0);
  return `${JSON.stringify(value)}\n`;
}
module.exports = {
  DOCUMENT_LIMIT,
  FRAME_LIMIT,
  RETAINED_LIMIT,
  textLimit,
  editorEligible,
  assertText,
  readText,
  prepareFrame,
  failure,
};
