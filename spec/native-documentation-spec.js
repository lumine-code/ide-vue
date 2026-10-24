const { guardCompletionDocumentation } = require("../lib/native-documentation");

describe("native Vue completion documentation", () => {
  const serviceFor = (symbol) => ({
    getCompletionsAtPosition: () => ({ entries: [{ symbol }] }),
  });

  it("preserves symbol identity and successful documentation", () => {
    const documentation = [{ kind: "text", text: "Original docs." }];
    const tags = [{ name: "deprecated", text: "Use another prop." }];
    const symbol = {
      getDocumentationComment: () => documentation,
      getJsDocTags: () => tags,
    };
    const service = serviceFor(symbol);
    guardCompletionDocumentation(service);
    expect(service.getCompletionsAtPosition().entries[0].symbol).toBe(symbol);
    expect(symbol.getDocumentationComment()).toBe(documentation);
    expect(symbol.getJsDocTags()).toBe(tags);
  });

  it("uses the current native checker for released-snapshot documentation and tags", () => {
    const expired = () => {
      throw new Error("api: client error: snapshot 1 not found");
    };
    const symbol = { getDocumentationComment: expired, getJsDocTags: expired };
    const service = serviceFor(symbol);
    guardCompletionDocumentation(service);
    service.getCompletionsAtPosition();
    const tags = [{ name: "deprecated", text: "Use another prop." }];
    const checker = {
      getDocumentationCommentOfSymbol: jasmine.createSpy("docs").and.returnValue("Current docs."),
      getJsDocTagsOfSymbol: jasmine.createSpy("tags").and.returnValue(tags),
    };
    expect(symbol.getDocumentationComment(checker)).toEqual([
      { kind: "text", text: "Current docs." },
    ]);
    expect(symbol.getJsDocTags(checker)).toBe(tags);
    expect(checker.getDocumentationCommentOfSymbol).toHaveBeenCalledOnceWith(symbol);
    expect(checker.getJsDocTagsOfSymbol).toHaveBeenCalledOnceWith(symbol);
  });

  it("propagates unrelated failures and an unavailable current checker", () => {
    const error = new Error("Native transport closed.");
    const symbol = {
      getDocumentationComment() {
        throw error;
      },
    };
    const service = serviceFor(symbol);
    guardCompletionDocumentation(service);
    service.getCompletionsAtPosition();
    expect(() => symbol.getDocumentationComment({ getDocumentationCommentOfSymbol() {} })).toThrow(
      error,
    );
    const expired = new Error("api: client error: snapshot 2 not found");
    const stale = {
      getDocumentationComment() {
        throw expired;
      },
    };
    const other = serviceFor(stale);
    guardCompletionDocumentation(other);
    other.getCompletionsAtPosition();
    expect(() => stale.getDocumentationComment({})).toThrow(expired);
  });
});
