// The native bridge can return a completion symbol from an already released
// snapshot. Its documentation methods read declarations before reaching their
// own current-checker fallback. Keep symbol identity for native type queries,
// but obtain documentation through that same fallback on this precise failure.
exports.guardCompletionDocumentation = (service) => {
  const complete = service.getCompletionsAtPosition;
  const guarded = new WeakSet();
  service.getCompletionsAtPosition = function (...args) {
    const result = complete.apply(this, args);
    for (const { symbol } of result?.entries || []) {
      if (!symbol || guarded.has(symbol)) continue;
      guarded.add(symbol);
      for (const [method, fallback] of [
        ["getDocumentationComment", "getDocumentationCommentOfSymbol"],
        ["getJsDocTags", "getJsDocTagsOfSymbol"],
      ]) {
        const original = symbol[method];
        if (typeof original !== "function") continue;
        Object.defineProperty(symbol, method, {
          configurable: true,
          value(checker) {
            try {
              return original.call(this, checker);
            } catch (error) {
              if (
                !/snapshot \d+ not found/.test(error.message) ||
                typeof checker?.[fallback] !== "function"
              )
                throw error;
              const value = checker[fallback](this);
              return method === "getDocumentationComment"
                ? value
                  ? [{ kind: "text", text: value }]
                  : []
                : value;
            }
          },
        });
      }
    }
    return result;
  };
};
